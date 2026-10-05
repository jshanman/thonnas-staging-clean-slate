import { StrategyRegistry } from '../types';

// @intent Capture single-AZ MVP mappings from abstract strategies to AWS constructs
export const STRATEGY_REGISTRY: StrategyRegistry = {
  'infra.container.managed-host': {
    default: {
      construct: 'ECSFargateService',
      runtimeType: 'ecs-fargate',
      scope: 'service',
      requires: [
        'vpc',
        'publicSubnet',
        'privateSubnet',
        'ecsCluster',
        'ecrRepository',
        'ecsExecutionRole',
        'ecsTaskRole',
        'ecsTaskSecurityGroup',
        'applicationLoadBalancer',
        'albSecurityGroup',
        'listenerHttps',
        'routingRule',
        'targetGroup',
        'logGroup',
      ],
    },
  },
  'infra.container.cluster': {
    default: {
      construct: 'ECSFargateService',
      runtimeType: 'ecs-fargate',
      scope: 'service',
      requires: [
        'vpc',
        'publicSubnet',
        'privateSubnet',
        'ecsCluster',
        'ecrRepository',
        'ecsExecutionRole',
        'ecsTaskRole',
        'ecsTaskSecurityGroup',
        'applicationLoadBalancer',
        'albSecurityGroup',
        'listenerHttps',
        'routingRule',
        'targetGroup',
        'logGroup',
      ],
    },
  },
  'infra.container.simple-vm': {
    default: {
      construct: 'SingleEC2DockerHost',
      runtimeType: 'ec2-docker',
      scope: 'service',
      requires: [
        'vpc',
        'publicSubnet',
        'ec2Instance',
        'ec2SecurityGroup',
        'ec2InstanceRole',
        'ecrRepository',
        'logGroup',
      ],
    },
  },
  'infra.container.compose-host': {
    default: {
      construct: 'ComposeHostEc2',
      runtimeType: 'compose-host',
      scope: 'service',
      requires: [
        'vpc',
        'publicSubnet',
        'composeHostInstance',
        'composeSecurityGroup',
        'composeInstanceRole',
        'composeLogGroup',
        'elasticIp',
        'route53Records',
      ],
    },
  },
  'infra.db.relational': {
    variants: {
      // @intent postgres → RdsPostgresInstance only; do not add a *-deploy variant
      postgres: {
        construct: 'RdsPostgresInstance',
        requires: ['vpc', 'privateSubnet', 'dbSecurityGroup', 'dbSubnetGroup', 'dbSecret', 'logGroup'],
      },
      'aurora-postgres': {
        construct: 'AuroraPostgresCluster',
        requires: ['vpc', 'privateSubnet', 'dbSecurityGroup', 'dbSubnetGroup', 'dbSecret', 'logGroup'],
      },
    },
  },
  'infra.cache.keyvalue': {
    variants: {
      redis: {
        construct: 'ElasticacheRedisCluster',
        requires: ['vpc', 'privateSubnet', 'cacheSecurityGroup', 'logGroup'],
      },
    },
  },
  'infra.worker.temporal': {
    default: {
      construct: 'TemporalServer',
      scope: 'service',
      requires: ['vpc', 'privateSubnet', 'ecsCluster', 'logGroup'],
    },
  },
  'infra.observe.metrics': {
    default: {
      construct: 'ObserveIngest',
      scope: 'service',
      requires: ['vpc', 'privateSubnet', 'ecsCluster', 'logGroup'],
    },
  },
  'infra.observe.dashboard': {
    default: {
      construct: 'ObserveIngest',
      scope: 'service',
      requires: ['vpc', 'privateSubnet', 'ecsCluster', 'applicationLoadBalancer'],
    },
  },
  // @intent Map DBA fleet compute to private EC2 with package-owned bootstrap
  'infra.compute.fleet.dba': {
    default: {
      construct: 'DbaFleet',
      scope: 'service',
      requires: ['vpc', 'privateSubnet', 'dbSecurityGroup', 'dbSecret', 'logGroup'],
    },
  },
  // @intent Map MQTT fleet compute to private EC2 (N nodes from scaling.min) with package-owned
  // bootstrap, same shape as fleet.dba
  'infra.compute.fleet.mqtt': {
    default: {
      construct: 'MqttFleet',
      scope: 'service',
      requires: ['vpc', 'privateSubnet', 'dbSecurityGroup', 'dbSecret', 'logGroup'],
    },
  },
  'infra.db.document': {
    variants: {
      'mongodb-compatible': {
        construct: 'AwsDocumentDbCluster',
        requires: ['vpc', 'privateSubnet', 'dbSecurityGroup', 'dbSubnetGroup', 'dbSecret', 'logGroup'],
      },
    },
  },
  'infra.artifact.deploy': {
    default: {
      construct: 'ArtifactDeploy',
      scope: 'service',
      requires: ['s3ArtifactDeployment'],
    },
  },
  'infra.artifact.website-bucket': {
    default: {
      construct: 'S3WebsiteBucket',
      scope: 'service',
      requires: ['s3WebsiteBucket', 'route53AliasForS3'],
    },
  },
  'infra.website.static': {
    default: {
      construct: 'StaticSite',
      scope: 'service',
      requires: ['s3WebsiteBucket', 'route53AliasForS3', 's3StaticSiteDeployment'],
    },
  },
  'infra.storage': {
    default: {
      construct: 'S3StorageBucket',
      scope: 'service',
      requires: ['s3StorageBucket'],
    },
  },
  'infra.api.storage-temp-url': {
    default: {
      construct: 'StorageTempUrlApi',
      scope: 'service',
      requires: ['storageTempUrlApi', 'cloudfrontDistribution', 'route53Record'],
    },
  },
  'comms.events.pub-sub.sns': {
    default: {
      construct: 'SnsSqsEventBus',
      scope: 'shared',
      requires: ['snsSqsEventBus'],
    },
  },
  'infra.identity.oidc': {
    default: {
      construct: 'GithubOidc',
      scope: 'shared',
      requires: ['githubOidcIdentity'],
    },
  },
};




