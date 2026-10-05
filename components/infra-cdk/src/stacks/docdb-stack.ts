import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { ResolvedCloudComponent } from '../types';
import { extraBoolean, extraNumber, resolvePortableExtras } from '../release/portable-extras';
import { defaultManagedSecretName } from '../utils/path-helpers';

export interface DocDbStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  networking: NetworkingStack;
  /** Portable extras from thonnas-infra (`secretName`, `peerSecurityGroupIds`, `engine`). */
  extras?: Record<string, unknown>;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];

const resolveDocDbExtras = (props: DocDbStackProps): Record<string, unknown> => ({
  ...(props.component.metadata.extras ?? {}),
  ...(props.extras ?? {}),
});

const resolveEngine = (extras: Record<string, unknown>, metadataEngine?: string): string => {
  if (typeof extras.engine === 'string' && extras.engine.trim()) return extras.engine.trim();
  if (metadataEngine && metadataEngine.trim()) return metadataEngine.trim();
  return 'mongodb-compatible';
};

const resolveSecretName = (props: DocDbStackProps, extras: Record<string, unknown>): string => {
  if (typeof extras.secretName === 'string' && extras.secretName.trim()) return extras.secretName.trim();
  const named = props.component.metadata.secrets?.find((secret) => secret.name.trim())?.name.trim();
  const kind = named && !named.includes('/') ? named : 'docdb';
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

// @intent Provision single-instance DocumentDB on private subnets with a generated secret
export class DocDbStack extends Stack {
  public readonly cluster: docdb.DatabaseCluster;
  public readonly secret: secretsmanager.ISecret;
  public readonly secretArn: string;
  public readonly clusterEndpoint: string;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DocDbStackProps) {
    super(scope, id, props);
    const privateSubnets = props.networking.privateSubnetSelection;
    if (!privateSubnets?.subnets?.length) {
      throw new Error(
        `DocDbStack requires private subnets (NAT) for env "${props.profile.envKey}". ` +
          'DocumentDB must not use public subnets. Enable private subnets on NetworkingStack (staging/production).',
      );
    }

    const extras = resolvePortableExtras({
      env: props.profile.envKey,
      extras: resolveDocDbExtras(props),
    });
    const protect = extraBoolean(extras, 'protect.fromDelete') === true;
    const multiAz = extraBoolean(extras, 'ha.multiAz') === true;
    const backupDays = extraNumber(extras, 'backup.retentionDays') ?? (protect ? 7 : 1);
    const engine = resolveEngine(extras, props.component.metadata.engine);
    if (engine !== 'mongodb-compatible') {
      throw new Error(
        `DocDbStack only supports engine: mongodb-compatible (got "${engine}"). ` +
          'This is a single compatible cluster, not a replica set.',
      );
    }

    const sg = new ec2.SecurityGroup(this, 'DocDbSg', {
      vpc: props.networking.vpc,
      description: 'DocumentDB ingress from declared peer SGs',
      allowAllOutbound: true,
    });
    this.dbSecurityGroup = sg;
    // @intent Allow 27017 only from named peer SGs; Fargate peers open on DocumentToEcs
    const peerIds = stringList(extras.peerSecurityGroupIds);
    peerIds.forEach((peerId, index) => {
      const peer = ec2.SecurityGroup.fromSecurityGroupId(this, `PeerSg${index}`, peerId, { mutable: false });
      sg.addIngressRule(peer, ec2.Port.tcp(27017), 'DocumentDB from peer SG');
    });

    const secretName = resolveSecretName(props, extras);
    this.cluster = new docdb.DatabaseCluster(this, 'DocumentDb', {
      masterUser: {
        username: 'thonnas',
        secretName,
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      vpc: props.networking.vpc,
      vpcSubnets: privateSubnets,
      securityGroup: sg,
      instances: multiAz ? 2 : 1,
      deletionProtection: protect,
      backup: { retention: Duration.days(backupDays) },
      removalPolicy: protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const generated = this.cluster.secret;
    if (!generated) {
      throw new Error('DocDbStack expected a generated Secrets Manager secret on the cluster.');
    }
    this.secret = generated;
    this.secretArn = generated.secretArn;
    this.clusterEndpoint = this.cluster.clusterEndpoint.socketAddress;
    new CfnOutput(this, 'DocDbSecretArn', { value: this.secretArn });
    new CfnOutput(this, 'DocDbEndpoint', { value: this.cluster.clusterEndpoint.hostname });
    new CfnOutput(this, 'DocDbPort', { value: String(this.cluster.clusterEndpoint.port) });
  }
}



