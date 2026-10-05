import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { ResolvedCloudComponent } from '../types';
import { extraBoolean, extraNumber, resolvePortableExtras } from '../release/portable-extras';
import { defaultManagedSecretName } from '../utils/path-helpers';

export interface RdsStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  networking: NetworkingStack;
  /** Portable extras from thonnas-infra (`secretName`, `peerSecurityGroupIds`, `engine`). */
  extras?: Record<string, unknown>;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];

const resolveRdsExtras = (props: RdsStackProps): Record<string, unknown> => ({
  ...(props.component.metadata.extras ?? {}),
  ...(props.extras ?? {}),
});

const resolveEngine = (extras: Record<string, unknown>, metadataEngine?: string): string => {
  if (typeof extras.engine === 'string' && extras.engine.trim()) return extras.engine.trim();
  if (metadataEngine && metadataEngine.trim()) return metadataEngine.trim();
  return 'postgres';
};

const resolveSecretName = (props: RdsStackProps, extras: Record<string, unknown>): string => {
  if (typeof extras.secretName === 'string' && extras.secretName.trim()) return extras.secretName.trim();
  const named = props.component.metadata.secrets?.find((secret) => secret.name.trim())?.name.trim();
  const kind = named && !named.includes('/') ? named : 'postgres';
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

// @intent Provision single-AZ Postgres on private subnets with a generated secret
export class RdsStack extends Stack {
  public readonly instance: rds.DatabaseInstance;
  public readonly secret: secretsmanager.ISecret;
  public readonly secretArn: string;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly databaseName: string;

  constructor(scope: Construct, id: string, props: RdsStackProps) {
    super(scope, id, props);
    const privateSubnets = props.networking.privateSubnetSelection;
    if (!privateSubnets?.subnets?.length) {
      throw new Error(
        `RdsStack requires private subnets (NAT) for env "${props.profile.envKey}". ` +
          'Postgres must not use public subnets. Enable private subnets on NetworkingStack (staging/production).',
      );
    }

    const extras = resolvePortableExtras({
      env: props.profile.envKey,
      extras: resolveRdsExtras(props),
    });
    const protect = extraBoolean(extras, 'protect.fromDelete') === true;
    const multiAz = extraBoolean(extras, 'ha.multiAz') === true;
    const backupDays = extraNumber(extras, 'backup.retentionDays') ?? (protect ? 7 : 1);
    const engine = resolveEngine(extras, props.component.metadata.engine);
    if (engine !== 'postgres') {
      throw new Error(
        `RdsStack only supports engine: postgres (got "${engine}"). Aurora is not implemented — do not map aurora-postgres to this stack.`,
      );
    }

    const sg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: props.networking.vpc,
      description: 'Postgres ingress from declared peer SGs',
      allowAllOutbound: true,
    });
    this.dbSecurityGroup = sg;
    // @intent Allow 5432 only from named peer SGs; Fargate peers open on RelationalToEcs
    const peerIds = stringList(extras.peerSecurityGroupIds);
    peerIds.forEach((peerId, index) => {
      const peer = ec2.SecurityGroup.fromSecurityGroupId(this, `PeerSg${index}`, peerId, { mutable: false });
      sg.addIngressRule(peer, ec2.Port.tcp(5432), 'Postgres from peer SG');
    });

    const secretName = resolveSecretName(props, extras);
    const databaseName =
      typeof extras.databaseName === 'string' && extras.databaseName.trim() ? extras.databaseName.trim() : 'thonnas';

    this.instance = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      vpc: props.networking.vpc,
      vpcSubnets: privateSubnets,
      securityGroups: [sg],
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      allocatedStorage: 20,
      multiAz,
      publiclyAccessible: false,
      deletionProtection: protect,
      removalPolicy: protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      backupRetention: Duration.days(backupDays),
      credentials: rds.Credentials.fromGeneratedSecret('thonnas', { secretName }),
      databaseName,
    });
    const generated = this.instance.secret;
    if (!generated) {
      throw new Error('RdsStack expected a generated Secrets Manager secret on the instance.');
    }
    this.secret = generated;
    this.secretArn = generated.secretArn;
    this.databaseName = databaseName;
  }
}




