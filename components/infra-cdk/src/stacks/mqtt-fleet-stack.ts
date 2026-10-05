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

export interface MqttFleetStackProps extends StackProps {
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

const resolveFleetExtras = (props: MqttFleetStackProps): Record<string, unknown> => ({
  ...(props.component.metadata.extras ?? {}),
  ...(props.extras ?? {}),
});

const resolveSecretName = (props: MqttFleetStackProps, extras: Record<string, unknown>): string => {
  if (typeof extras.secretName === 'string' && extras.secretName.trim()) return extras.secretName.trim();
  const named = props.component.metadata.secrets?.find((secret) => secret.name.trim())?.name.trim();
  const kind = named && !named.includes('/') ? named : 'mqtt-fleet';
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

const DEFAULT_VOLUME_PATH = '/var/lib/mqtt-data';
const DEFAULT_NODE_COUNT = 1;
const MAX_NODE_COUNT = 5;

// @intent Provision a static-discovery MQTT broker cluster (private EC2, N nodes) with durable
// volumes; mirrors DbaFleetStack's shape (bare instance(s), package-owned bootstrap via SSM/
// extras.bootstrapUrl) but sizes the fleet from the same scaling.min/scaling.max portable extras
// every other strategy already exposes, instead of hardcoding a single instance -- N is known at
// synth time, so every node's userdata can be handed the full peer IP list directly (CFN
// intrinsics resolve each instance's private IP at deploy time; no runtime discovery service
// needed for a fixed-size fleet).
export class MqttFleetStack extends Stack {
  public readonly secret: secretsmanager.ISecret;
  public readonly secretArn: string;
  public readonly ingestSecurityGroup: ec2.SecurityGroup;
  public readonly endpointHost: string;
  public readonly nodePrivateIps: string[];
  public readonly volumePath: string;

  constructor(scope: Construct, id: string, props: MqttFleetStackProps) {
    super(scope, id, props);
    const privateSubnets = props.networking.privateSubnetSelection;
    if (!privateSubnets?.subnets?.length) {
      throw new Error(
        `MqttFleetStack requires private subnets (NAT) for env "${props.profile.envKey}". ` +
          'MQTT fleet hosts must not use public subnets. Enable private subnets on NetworkingStack.',
      );
    }

    const extras = resolvePortableExtras({
      env: props.profile.envKey,
      extras: resolveFleetExtras(props),
    });
    const protect = extraBoolean(extras, 'protect.fromDelete') === true;
    const backupDays = extraNumber(extras, 'backup.retentionDays') ?? (protect ? 7 : 1);
    const volumeGb = extraNumber(extras, 'volume.sizeGb') ?? 20;
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
    // @intent scaling.min/scaling.max are the same portable-extras keys every other strategy
    // resolves from capacity+reliability (or an explicit override) -- read here as the fleet's
    // fixed node count rather than left unused the way DbaFleetStack currently leaves them.
    const requestedNodeCount = extraNumber(extras, 'scaling.min') ?? DEFAULT_NODE_COUNT;
    const nodeCount = Math.min(MAX_NODE_COUNT, Math.max(1, Math.round(requestedNodeCount)));

    const sg = new ec2.SecurityGroup(this, 'MqttFleetSg', {
      vpc: props.networking.vpc,
      description: 'MQTT fleet peer ingress only (no public 0.0.0.0/0)',
      allowAllOutbound: true,
    });
    this.ingestSecurityGroup = sg;
    // @intent Allow package-declared service ports only from named peer SGs
    const peerIds = stringList(extras.peerSecurityGroupIds);
    peerIds.forEach((peerId, index) => {
      const peer = ec2.SecurityGroup.fromSecurityGroupId(this, `PeerSg${index}`, peerId, { mutable: false });
      servicePorts.forEach((port) => {
        sg.addIngressRule(peer, ec2.Port.tcp(port), `MQTT fleet port ${port} from peer SG`);
      });
    });
    // @intent NLB IP-target traffic has no security group of its own to reference (unlike ALB) --
    // its ENIs live in-VPC, so the standard pattern is allowing the VPC CIDR on the target ports.
    servicePorts.forEach((port) => {
      sg.addIngressRule(
        ec2.Peer.ipv4(props.networking.vpc.vpcCidrBlock),
        ec2.Port.tcp(port),
        `MQTT fleet port ${port} from in-VPC NLB targets (health checks + traffic)`,
      );
    });
    // @intent Cluster nodes must reach each other's Erlang distribution + gen_rpc + MQTT ports
    // directly. Distribution (epmd 4370 + 4371-4380) is enough for mnesia/cluster *membership* --
    // confirmed live: `emqx_ctl cluster status` correctly showed both nodes as running_nodes with
    // only this range open, which made the gap easy to miss. Actual cross-node MQTT message
    // *routing* goes over a separate library, gen_rpc, on a different port range entirely
    // (base 5370 + per-node offset) -- without it open, publishing on one node silently never
    // reaches a subscriber connected to another, while cluster status still looks healthy.
    sg.addIngressRule(sg, ec2.Port.tcp(4370), 'EMQX Erlang port mapper (epmd) between cluster nodes');
    sg.addIngressRule(sg, ec2.Port.tcpRange(4371, 4380), 'EMQX inter-node distribution between cluster nodes');
    sg.addIngressRule(sg, ec2.Port.tcpRange(5370, 5380), 'EMQX gen_rpc (actual message routing) between cluster nodes');
    servicePorts.forEach((port) => {
      sg.addIngressRule(sg, ec2.Port.tcp(port), `MQTT fleet port ${port} between cluster nodes`);
    });

    const secret = new secretsmanager.Secret(this, 'MqttFleetSecret', {
      secretName,
      description: `MQTT fleet credentials for ${envKey}/${componentKey}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'thonnas' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
      removalPolicy: protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.secret = secret;
    this.secretArn = secret.secretArn;

    const role = new iam.Role(this, 'MqttFleetInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    secret.grantRead(role);
    // @intent The browser-facing frontend credential is a separate, user-provided config-thonnas
    // secret (not this stack's own auto-generated fleet secret), looked up by the bootstrap
    // script at {env}/{componentKey}/QUEUE_MQTT_FRONTEND_PASSWORD -- grant read access to that
    // name here too so the fleet's own instance role can actually fetch it. fromSecretNameV2
    // resolves to a wildcard-suffixed ARN at grant time since the real secret (created by
    // `thonnas config setup`, not this stack) has an AWS-appended random suffix we can't know at
    // synth time.
    secretsmanager.Secret.fromSecretNameV2(
      this,
      'MqttFleetFrontendSecret',
      `${envKey}/${componentKey}/QUEUE_MQTT_FRONTEND_PASSWORD`,
    ).grantRead(role);
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    // @intent Two instances cannot reference each other's PrivateIp attribute from within their
    // own resource properties (UserData) -- CDK's synthesizer correctly rejects that as a
    // dependency cycle, and it's not just a synth quirk: CloudFormation genuinely cannot resolve
    // "instance A's UserData needs instance B's IP" and "B's UserData needs A's IP" in one
    // stack. Discover peers at boot instead (DescribeInstances is read-only and does not support
    // per-resource ARN scoping) filtered by the shared fleet tag set below.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }),
    );

    // @intent xs+dev proven size stays t3.small; staging/production request more via capacity
    const instanceSize =
      extras.capacity === 'm' || extras.capacity === 'l' || extras.capacity === 'xl'
        ? ec2.InstanceSize.MEDIUM
        : ec2.InstanceSize.SMALL;

    const instances: ec2.Instance[] = [];
    for (let i = 0; i < nodeCount; i += 1) {
      const instance = new ec2.Instance(this, `MqttFleetInstance${i}`, {
        vpc: props.networking.vpc,
        vpcSubnets: privateSubnets,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, instanceSize),
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
      // @intent Same launch-template-name collision fix as DbaFleetStack (account-global names);
      // see that file's comment for why an Aspect cannot be used instead.
      const launchTemplateName = `${this.stackName}-mqtt-${i}-lt`.slice(0, 128);
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
      // @intent Shared value every node in this fleet can filter DescribeInstances on at boot to
      // discover its siblings -- the stack name is already unique per env/component and known at
      // synth time, so this needs no CFN token (unlike a peer's PrivateIp).
      Tags.of(instance).add('thonnas.mqtt.fleetId', this.stackName);
      Tags.of(instance).add('backup.retentionDays', String(backupDays));
      Tags.of(instance).add('thonnas.mqtt.volumePath', volumePath);
      Tags.of(instance).add('thonnas.mqtt.nodeIndex', String(i));
      instance.applyRemovalPolicy(protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);
      instances.push(instance);
    }

    instances.forEach((instance, i) => {
      const bootstrapLines = [
        'set -eux',
        `VOLUME_PATH='${volumePath}'`,
        `SECRET_ARN='${secret.secretArn}'`,
        `NODE_INDEX='${i}'`,
        `FLEET_ID='${this.stackName}'`,
        `EXPECTED_NODE_COUNT='${nodeCount}'`,
        'mkdir -p "$VOLUME_PATH"',
        'export THONNAS_MQTT_FLEET_VOLUME_PATH="$VOLUME_PATH"',
        'export THONNAS_MQTT_FLEET_SECRET_ARN="$SECRET_ARN"',
        'export THONNAS_MQTT_FLEET_NODE_INDEX="$NODE_INDEX"',
        'export THONNAS_MQTT_FLEET_ID="$FLEET_ID"',
        'export THONNAS_MQTT_FLEET_EXPECTED_NODE_COUNT="$EXPECTED_NODE_COUNT"',
      ];
      if (bootstrapUrl) {
        bootstrapLines.push(
          `BOOTSTRAP_URL='${bootstrapUrl.replace(/'/g, "'\\''")}'`,
          'curl -fsSL "$BOOTSTRAP_URL" -o /tmp/thonnas-mqtt-bootstrap.sh',
          'chmod +x /tmp/thonnas-mqtt-bootstrap.sh',
          '/tmp/thonnas-mqtt-bootstrap.sh',
        );
      } else {
        bootstrapLines.push(
          'echo "MqttFleetStack: no extras.bootstrapUrl — package must supply bootstrap via release/SSM"',
        );
      }
      instance.addUserData(...bootstrapLines);
    });

    this.nodePrivateIps = instances.map((instance) => instance.instancePrivateIp);
    this.endpointHost = instances[0].instancePrivateIp;

    new CfnOutput(this, 'MqttFleetSecretArn', { value: this.secretArn });
    new CfnOutput(this, 'MqttFleetHost', { value: this.endpointHost });
    new CfnOutput(this, 'MqttFleetVolumePath', { value: this.volumePath });
    new CfnOutput(this, 'MqttFleetNodeCount', { value: String(nodeCount) });
    // @intent Fn::Join over the token array (not the already-resolved JS peerIpList string) so
    // this output reflects the real per-node IPs CloudFormation assigns, not a synth-time guess.
    new CfnOutput(this, 'MqttFleetNodeIps', {
      value: instances.map((instance) => instance.instancePrivateIp).join(','),
    });
  }
}

