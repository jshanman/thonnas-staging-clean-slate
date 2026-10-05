import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { ResolvedCloudComponent } from '../types';
import { extraNumber, resolvePortableExtras } from '../release/portable-extras';
import { defaultManagedSecretName } from '../utils/path-helpers';

export interface RedisStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  networking: NetworkingStack;
  /** Portable extras from thonnas-infra (`secretName`, `peerSecurityGroupIds`, `engine`). */
  extras?: Record<string, unknown>;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];

const resolveRedisExtras = (props: RedisStackProps): Record<string, unknown> => ({
  ...(props.component.metadata.extras ?? {}),
  ...(props.extras ?? {}),
});

const resolveEngine = (extras: Record<string, unknown>, metadataEngine?: string): string => {
  if (typeof extras.engine === 'string' && extras.engine.trim()) return extras.engine.trim();
  if (metadataEngine && metadataEngine.trim()) return metadataEngine.trim();
  return 'redis';
};

const resolveSecretName = (props: RedisStackProps, extras: Record<string, unknown>): string => {
  if (typeof extras.secretName === 'string' && extras.secretName.trim()) return extras.secretName.trim();
  const named = props.component.metadata.secrets?.find((secret) => secret.name.trim())?.name.trim();
  const kind = named && !named.includes('/') ? named : 'redis';
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

// @intent Provision single-node Redis on private subnets with a generated AUTH secret
export class RedisStack extends Stack {
  public readonly endpoint: string;
  public readonly secretArn: string;
  public readonly secret: secretsmanager.ISecret;
  public readonly cacheSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: RedisStackProps) {
    super(scope, id, props);
    const privateSubnets = props.networking.privateSubnetSelection;
    if (!privateSubnets?.subnets?.length) {
      throw new Error(
        `RedisStack requires private subnets (NAT) for env "${props.profile.envKey}". ` +
          'Redis must not use public subnets. Enable private subnets on NetworkingStack (staging/production).',
      );
    }

    const extras = resolvePortableExtras({
      env: props.profile.envKey,
      extras: resolveRedisExtras(props),
    });
    const snapshotDays = extraNumber(extras, 'backup.retentionDays');
    const replicaCount = extraNumber(extras, 'replicaCount') ?? extraNumber(extras, 'numCacheClusters');
    const engine = resolveEngine(extras, props.component.metadata.engine);
    if (engine !== 'redis') {
      throw new Error(
        `RedisStack only supports engine: redis (got "${engine}"). ` +
          'This is a single-node cache, not Redis cluster mode.',
      );
    }

    const sg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: props.networking.vpc,
      description: 'Redis ingress from declared peer SGs',
      allowAllOutbound: true,
    });
    this.cacheSecurityGroup = sg;
    // @intent Allow 6379 only from named peer SGs; leave closed if none declared
    const peerIds = stringList(extras.peerSecurityGroupIds);
    peerIds.forEach((peerId, index) => {
      const peer = ec2.SecurityGroup.fromSecurityGroupId(this, `PeerSg${index}`, peerId, { mutable: false });
      sg.addIngressRule(peer, ec2.Port.tcp(6379), 'Redis from peer SG');
    });

    const secretName = resolveSecretName(props, extras);
    // @intent Generate AUTH token in Secrets Manager; enable transit encryption AUTH requires
    const authSecret = new secretsmanager.Secret(this, 'Auth', {
      secretName,
      description: `${props.profile.envKey} redis AUTH`,
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
        excludeCharacters: '@"/\\',
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.secretArn = authSecret.secretArn;
    this.secret = authSecret;

    const subnetIds = privateSubnets.subnets.map((s) => s.subnetId);
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: `${props.profile.envKey} redis`,
      subnetIds,
    });
    subnetGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // AUTH is not a CacheCluster property; a 1-node replication group is still not cluster mode.
    const cluster = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: `${props.profile.envKey} redis`,
      replicationGroupId: `${props.profile.envKey}-${props.component.component}`.slice(0, 40),
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheClusters: replicaCount && replicaCount > 1 ? replicaCount : 1,
      automaticFailoverEnabled: Boolean(replicaCount && replicaCount > 1),
      snapshotRetentionLimit: snapshotDays && snapshotDays > 0 ? snapshotDays : undefined,
      securityGroupIds: [sg.securityGroupId],
      cacheSubnetGroupName: subnetGroup.ref,
      transitEncryptionEnabled: true,
      authToken: authSecret.secretValue.unsafeUnwrap(),
    });
    cluster.addDependency(subnetGroup);
    cluster.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.endpoint = cluster.attrPrimaryEndPointAddress;
    new CfnOutput(this, 'RedisEndpoint', { value: this.endpoint });
  }
}



