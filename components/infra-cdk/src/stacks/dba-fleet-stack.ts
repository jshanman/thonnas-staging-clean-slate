import { CfnOutput, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { ResolvedCloudComponent } from '../types';
import { extraBoolean, extraNumber, resolvePortableExtras } from '../release/portable-extras';
import { defaultManagedSecretName } from '../utils/path-helpers';

export interface DbaFleetStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  networking: NetworkingStack;
  extras?: Record<string, unknown>;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];

const numberList = (value: unknown): number[] =>
  Array.isArray(value)
    ? value
        .map((item) => (typeof item === 'number' ? item : Number(item)))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];

const resolveFleetExtras = (props: DbaFleetStackProps): Record<string, unknown> => ({
  ...(props.component.metadata.extras ?? {}),
  ...(props.extras ?? {}),
});

const resolveSecretName = (props: DbaFleetStackProps, extras: Record<string, unknown>): string => {
  if (typeof extras.secretName === 'string' && extras.secretName.trim()) return extras.secretName.trim();
  const named = props.component.metadata.secrets?.find((secret) => secret.name.trim())?.name.trim();
  const kind = named && !named.includes('/') ? named : 'dba-fleet';
  if (named?.includes('/')) {
    const proj = (props.profile.projectKey || '').toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 32);
    return proj && !named.startsWith(`${proj}/`) ? `${proj}/${named}` : named;
  }
  return defaultManagedSecretName(
    props.profile.projectKey,
    props.profile.envKey,
    props.component.component,
    kind,
  );
};

const DEFAULT_VOLUME_PATH = '/var/lib/dba-data';

// @intent Provision private EC2 DBA fleet host with durable volume; invoke package bootstrap only
export class DbaFleetStack extends Stack {
  public readonly secret: secretsmanager.ISecret;
  public readonly secretArn: string;
  public readonly ingestSecurityGroup: ec2.SecurityGroup;
  public readonly endpointHost: string;
  public readonly volumePath: string;

  constructor(scope: Construct, id: string, props: DbaFleetStackProps) {
    super(scope, id, props);
    const privateSubnets = props.networking.privateSubnetSelection;
    if (!privateSubnets?.subnets?.length) {
      throw new Error(
        `DbaFleetStack requires private subnets (NAT) for env "${props.profile.envKey}". ` +
          'DBA fleet hosts must not use public subnets. Enable private subnets on NetworkingStack.',
      );
    }

    const extras = resolvePortableExtras({
      env: props.profile.envKey,
      extras: resolveFleetExtras(props),
    });
    const protect = extraBoolean(extras, 'protect.fromDelete') === true;
    const backupDays = extraNumber(extras, 'backup.retentionDays') ?? (protect ? 7 : 1);
    const volumeGb = extraNumber(extras, 'volume.sizeGb') ?? 40;
    const volumePath =
      typeof extras.volumePath === 'string' && extras.volumePath.trim()
        ? extras.volumePath.trim()
        : DEFAULT_VOLUME_PATH;
    this.volumePath = volumePath;
    const envKey = props.profile.envKey;
    const componentKey = props.component.component;
    const secretName = resolveSecretName(props, extras);
    const servicePorts = numberList(extras.servicePorts);
    const bootstrapUrl =
      typeof extras.bootstrapUrl === 'string' && extras.bootstrapUrl.trim()
        ? extras.bootstrapUrl.trim()
        : '';

    const sg = new ec2.SecurityGroup(this, 'DbaFleetSg', {
      vpc: props.networking.vpc,
      description: 'DBA fleet peer ingress only (no public 0.0.0.0/0)',
      allowAllOutbound: true,
    });
    this.ingestSecurityGroup = sg;
    // @intent Allow package-declared service ports only from named peer SGs
    const peerIds = stringList(extras.peerSecurityGroupIds);
    peerIds.forEach((peerId, index) => {
      const peer = ec2.SecurityGroup.fromSecurityGroupId(this, `PeerSg${index}`, peerId, { mutable: false });
      servicePorts.forEach((port) => {
        sg.addIngressRule(peer, ec2.Port.tcp(port), `DBA fleet port ${port} from peer SG`);
      });
    });

    const secret = new secretsmanager.Secret(this, 'DbaFleetSecret', {
      secretName,
      description: `DBA fleet credentials for ${envKey}/${componentKey}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'thonnas' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
      removalPolicy: protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.secret = secret;
    this.secretArn = secret.secretArn;

    const role = new iam.Role(this, 'DbaFleetInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    secret.grantRead(role);
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    // @intent xs+dev prove stays t3.small; do not raise live inventeds size
    const instance = new ec2.Instance(this, 'DbaFleetInstance', {
      vpc: props.networking.vpc,
      vpcSubnets: privateSubnets,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(volumeGb, { encrypted: true, deleteOnTermination: !protect }),
        },
      ],
    });
    // @intent Launch template names are account-global; rename the auto-created LT to a
    // stack-scoped name. The Instance L2 construct bakes the *original* default LT name into
    // the Instance resource's own LaunchTemplate.LaunchTemplateName property at construction
    // time (a plain string, not a Ref), so renaming only the CfnLaunchTemplate node (e.g. via
    // an Aspect) leaves the Instance pointing at a name that no longer exists ("specified
    // launch template ... does not exist"). Find the already-created CfnLaunchTemplate directly
    // (no Aspect needed -- it exists synchronously as soon as `new ec2.Instance` returns) and
    // override both sides so they agree.
    const launchTemplateName = `${this.stackName}-dba-lt`.slice(0, 128);
    const cfnLaunchTemplate = instance.node
      .findAll()
      .find((node): node is ec2.CfnLaunchTemplate => node instanceof ec2.CfnLaunchTemplate);
    if (cfnLaunchTemplate) {
      cfnLaunchTemplate.launchTemplateName = launchTemplateName;
    }
    const cfnInstance = instance.instance;
    if (cfnLaunchTemplate) {
      cfnInstance.addPropertyOverride('LaunchTemplate.LaunchTemplateName', launchTemplateName);
    }
    cfnInstance.disableApiTermination = protect;
    if (protect) {
      this.terminationProtection = true;
    }
    Tags.of(instance).add('backup.retentionDays', String(backupDays));
    Tags.of(instance).add('thonnas.dba.volumePath', volumePath);
    instance.applyRemovalPolicy(protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);

    // @intent Invoke package-owned bootstrap only — no product install steps in provider
    const bootstrapLines = [
      'set -eux',
      `VOLUME_PATH='${volumePath}'`,
      `SECRET_ARN='${secret.secretArn}'`,
      'mkdir -p "$VOLUME_PATH"',
      'export THONNAS_DBA_FLEET_VOLUME_PATH="$VOLUME_PATH"',
      'export THONNAS_DBA_FLEET_SECRET_ARN="$SECRET_ARN"',
    ];
    if (bootstrapUrl) {
      bootstrapLines.push(
        `BOOTSTRAP_URL='${bootstrapUrl.replace(/'/g, "'\\''")}'`,
        'curl -fsSL "$BOOTSTRAP_URL" -o /tmp/thonnas-dba-bootstrap.sh',
        'chmod +x /tmp/thonnas-dba-bootstrap.sh',
        '/tmp/thonnas-dba-bootstrap.sh',
      );
    } else {
      bootstrapLines.push(
        'echo "DbaFleetStack: no extras.bootstrapUrl — package must supply bootstrap via release/SSM"',
      );
    }
    instance.addUserData(...bootstrapLines);

    this.endpointHost = instance.instancePrivateIp;

    new CfnOutput(this, 'DbaFleetSecretArn', { value: this.secretArn });
    new CfnOutput(this, 'DbaFleetHost', { value: this.endpointHost });
    new CfnOutput(this, 'DbaFleetVolumePath', { value: this.volumePath });
  }
}



