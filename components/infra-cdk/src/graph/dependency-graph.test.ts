import { describe, expect, it } from '@jest/globals';
import { buildDependencyGraph } from './dependency-graph';
import {
  DeploymentIntent,
  PlannedResource,
  ResolvedCloudComponent,
  StrategyResolutionResult,
} from '../types';

const makeComponent = (component: string, env: string): ResolvedCloudComponent => ({
  id: `${env}-${component}-runtime`,
  component,
  env,
  strategy: 'runtime',
  construct: 'ECSFargateService',
  scope: 'service',
  requires: [
    'vpc',
    'publicSubnet',
    'privateSubnet',
    'ecsCluster',
    'applicationLoadBalancer',
    'albSecurityGroup',
    'listenerHttps',
    'routingRule',
    'targetGroup',
    'ecrRepository',
    'ecsExecutionRole',
    'ecsTaskRole',
    'ecsTaskSecurityGroup',
    'logGroup',
  ],
  metadata: {
    hostname: `${env}.${component}.example.com`,
    runtimeType: 'ecs-fargate',
    routing: 'alb',
    ports: [8080],
    targetGroupPort: 8080,
  },
});

const makeResources = (component: string, env: string): PlannedResource[] => [
  {
    id: `ecr-${env}-${component}`,
    kind: 'ecrRepository',
    env,
    scope: 'service',
    component,
    props: { name: `${env}-${component}` },
  },
  {
    id: `iam-${env}-${component}-ecs-exec`,
    kind: 'iamRole',
    env,
    scope: 'service',
    component,
    props: { name: `${env}-${component}-ecs-exec` },
  },
  {
    id: `iam-${env}-${component}-ecs-task`,
    kind: 'iamRole',
    env,
    scope: 'service',
    component,
    props: { name: `${env}-${component}-ecs-task` },
  },
  {
    id: `log-${env}-${component}`,
    kind: 'logGroup',
    env,
    scope: 'service',
    component,
    props: { name: `/thonnas/${env}/${component}` },
  },
];

const intents: DeploymentIntent[] = [
  {
    component: 'api',
    componentPath: 'components/api',
    thonnasInfraVersion: 1,
    domainPattern: '{env}.{component}.example.com',
    strategies: {},
    environments: {},
    requiredSecrets: [],
  },
  {
    component: 'web',
    componentPath: 'components/web',
    thonnasInfraVersion: 1,
    domainPattern: '{env}.{component}.example.com',
    strategies: {},
    environments: {},
    requiredSecrets: [],
  },
];

const makeComposeComponent = (env: string): ResolvedCloudComponent => ({
  id: `${env}-compose-runtime`,
  component: 'infra-docker',
  env,
  strategy: 'composeHost',
  construct: 'ComposeHostEc2',
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
  metadata: {
    hostname: `${env}.compose.example.com`,
    runtimeType: 'compose-host',
    routing: 'direct',
      compose: {
        gitRepositoryUrl: 'https://github.com/example/project.git',
        branch: 'main',
        composeFile: 'components/infra-docker/docker-compose.yml',
        workingDirectory: '/opt/app',
        publishedServices: [
          { name: 'api', port: 3000, protocol: 'http', hostname: `${env}.api.example.com` },
          { name: 'web', port: 4200, protocol: 'http', hostname: `${env}.web.example.com` },
        ],
        gitPasswordSecretName: 'TEST_PROJECT_GIT_PWD',
      },
  },
});

describe('buildDependencyGraph', () => {
  it('deduplicates shared resources per environment', () => {
    const resolution: StrategyResolutionResult = {
      components: [makeComponent('api', 'staging'), makeComponent('web', 'staging')],
      resources: [
        ...makeResources('api', 'staging'),
        ...makeResources('web', 'staging'),
        {
          id: 'sg-staging-alb-sg',
          kind: 'securityGroup',
          env: 'staging',
          scope: 'shared',
          props: {},
        },
      ],
    };

    const graph = buildDependencyGraph('staging', intents, resolution);
    const vpcNodes = graph.nodes.filter((node) => node.type === 'VPC');
    expect(vpcNodes).toHaveLength(1);
    expect(graph.nodes.some((node) => node.id === 'staging-alb')).toBe(true);
  });

  it('creates service-scoped target groups per component', () => {
    const resolution: StrategyResolutionResult = {
      components: [makeComponent('api', 'staging'), makeComponent('web', 'staging')],
      resources: [...makeResources('api', 'staging'), ...makeResources('web', 'staging')],
    };

    const graph = buildDependencyGraph('staging', intents, resolution);
    const targetGroups = graph.nodes.filter((node) => node.type === 'TargetGroup');
    expect(targetGroups).toHaveLength(2);
    const apiTg = targetGroups.find((node) => node.id.includes('api'));
    const webTg = targetGroups.find((node) => node.id.includes('web'));
    expect(apiTg?.props.port).toBe(8080);
    expect(webTg?.props.port).toBe(8080);
  });

  it('adds compose host nodes with dns + elastic ip', () => {
    const composeComponent = makeComposeComponent('beta');
    const resolution: StrategyResolutionResult = {
      components: [composeComponent],
      resources: [
        {
          id: `log-beta-${composeComponent.component}`,
          kind: 'logGroup',
          env: 'beta',
          scope: 'service',
          component: composeComponent.component,
          props: { name: `/thonnas/beta/${composeComponent.component}` },
        },
        { id: 'eip-beta-infra-docker', kind: 'elasticIp', env: 'beta', scope: 'service', component: composeComponent.component, props: {} },
        { id: 'dns-beta.api.example.com', kind: 'dnsRecord', env: 'beta', scope: 'service', component: composeComponent.component, props: {} },
      ],
    };

    const graph = buildDependencyGraph('beta', intents, resolution);
    expect(graph.nodes.some((node) => node.type === 'ComposeHostInstance')).toBe(true);
    expect(graph.nodes.some((node) => node.type === 'ElasticIp')).toBe(true);
    expect(graph.nodes.some((node) => node.type === 'Route53Record')).toBe(true);
  });
});




