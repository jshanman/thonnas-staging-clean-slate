import { describe, expect, it } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { createCdkApp } from '../cdk/runtime';
import { NetworkingStack } from './networking-stack';
import { EcsSharedStack } from './ecs-shared-stack';
import { EcsServiceStack, FARGATE_PAUSE_IMAGE, listenerRulePriority, serviceLogGroup } from './ecs-service-stack';
import { RedisStack } from './redis-stack';
import { DocDbStack } from './docdb-stack';
import { DocumentToEcsStack } from './document-to-ecs-stack';
import { CacheToEcsStack } from './cache-to-ecs-stack';
import { NlbStack } from './nlb-stack';
import { RdsStack } from './rds-stack';
import { TemporalStack } from './temporal-stack';
import { DependencyGraph, ResolvedCloudComponent } from '../types';

const env = { account: '123456789012', region: 'us-east-1' };
const certArn = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111';

const fixtureApi = (overrides?: Partial<ResolvedCloudComponent>): ResolvedCloudComponent => ({
  id: 'staging-fixture-api-runtime',
  component: 'fixture-api',
  env: 'staging',
  strategy: 'runtime',
  construct: 'ECSFargateService',
  scope: 'service',
  requires: [],
  metadata: {
    runtimeType: 'ecs-fargate',
    ports: [3000],
    exposed: true,
    hostname: 'staging.fixture-api.example.local',
    routing: 'alb',
    certificateArn: certArn,
    extras: {},
  },
  ...overrides,
});

const fixtureCache = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-cache-cache',
  component: 'fixture-cache',
  env: 'staging',
  strategy: 'cache',
  construct: 'ElasticacheRedisCluster',
  scope: 'service',
  requires: [],
  metadata: {
    extras: { engine: 'redis' },
    engine: 'redis',
  },
});

const fixtureDoc = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-doc-document',
  component: 'fixture-doc',
  env: 'staging',
  strategy: 'document',
  construct: 'AwsDocumentDbCluster',
  scope: 'service',
  requires: [],
  metadata: {
    extras: { engine: 'mongodb-compatible' },
    engine: 'mongodb-compatible',
  },
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

describe('EcsServiceStack', () => {
  it('uses the pause image and portable port/hostname without an app build', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', [fixtureApi()]);
    const networking = new NetworkingStack(app, 'Net', { env, profile, maxAzs: 2 });
    const shared = new EcsSharedStack(app, 'Wiring', {
      env,
      profile,
      networking,
      enableAlb: true,
      certificateArn: certArn,
    });
    const stack = new EcsServiceStack(app, 'Svc', {
      env,
      profile,
      networking,
      shared,
      component: fixtureApi(),
      repositoryName: 'unused',
      imageTag: 'latest',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'unused',
      LifecyclePolicy: Match.objectLike({
        LifecyclePolicyText: Match.stringLikeRegexp('maxImageCount|countNumber'),
      }),
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: FARGATE_PAUSE_IMAGE,
          PortMappings: Match.arrayWith([Match.objectLike({ ContainerPort: 3000 })]),
        }),
      ]),
    });
    expect(stack.serviceSecurityGroup.securityGroupId).toBeTruthy();
    expect(stack.serviceSecurityGroupExportName).toBe('Svc-ServiceSg');
    expect(JSON.stringify(template.toJSON().Outputs ?? {})).toMatch(/Svc-ServiceSg/);
    expect(JSON.stringify(template.findResources('AWS::IAM::Role'))).toContain('AmazonEC2ContainerRegistryReadOnly');
  });

  it('keeps a released image and env when apply re-synthesizes the service', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', [fixtureApi()]);
    const networking = new NetworkingStack(app, 'NetKeep', { env, profile, maxAzs: 2 });
    const shared = new EcsSharedStack(app, 'WiringKeep', {
      env,
      profile,
      networking,
      enableAlb: true,
      certificateArn: certArn,
    });
    const stack = new EcsServiceStack(app, 'SvcKeep', {
      env,
      profile,
      networking,
      shared,
      component: fixtureApi(),
      repositoryName: 'unused',
      imageTag: 'latest',
      releasedContainer: {
        image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/demo/staging-fixture-api:rel-1',
        environment: [
          { name: 'THONNAS_ENV', value: 'staging' },
          { name: 'JWT_SECRET', value: 'from-release' },
        ],
        secrets: [],
      },
    });
    const template = Template.fromStack(stack);
    const taskJson = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).toContain('123456789012.dkr.ecr.us-east-1.amazonaws.com/demo/staging-fixture-api:rel-1');
    expect(taskJson).toContain('JWT_SECRET');
    expect(taskJson).toContain('from-release');
    expect(taskJson).not.toContain(FARGATE_PAUSE_IMAGE);
  });

  it('creates project-prefixed ECR repository names from repositoryName', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', [fixtureApi()], undefined, 'e2efe001');
    const networking = new NetworkingStack(app, 'NetEcr', { env, profile, maxAzs: 2 });
    const shared = new EcsSharedStack(app, 'WiringEcr', {
      env,
      profile,
      networking,
      enableAlb: true,
      certificateArn: certArn,
    });
    const stack = new EcsServiceStack(app, 'SvcEcr', {
      env,
      profile,
      networking,
      shared,
      component: fixtureApi(),
      repositoryName: 'e2efe001/staging-fixture-api',
      imageTag: 'latest',
    });
    Template.fromStack(stack).hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'e2efe001/staging-fixture-api',
    });
  });

  it('throws when private subnets are missing', () => {
    const app = new App();
    const betaApi = { ...fixtureApi(), env: 'beta', metadata: { ...fixtureApi().metadata, runtimeType: 'ecs-fargate' as const } };
    const profile = buildEnvProfile('beta', [betaApi]);
    const networking = new NetworkingStack(app, 'NetBeta', { env, profile, maxAzs: 2 });
    const shared = new EcsSharedStack(app, 'WiringBeta', {
      env,
      profile,
      networking,
      enableAlb: true,
    });
    expect(
      () =>
        new EcsServiceStack(app, 'SvcBeta', {
          env,
          profile,
          networking,
          shared,
          component: betaApi,
          repositoryName: 'unused',
          imageTag: 'latest',
        }),
    ).toThrow(/private subnet/i);
  });
});

describe('createCdkApp Fargate wiring', () => {
  it('uses metadata hostname and port via createCdkApp without workshop names', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureApi()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stack = app.node.findAll().find((node) => node instanceof EcsServiceStack) as EcsServiceStack | undefined;
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([Match.objectLike({ Image: FARGATE_PAUSE_IMAGE })]),
    });
    const listenerRules = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
    const hostHeaders = JSON.stringify(listenerRules);
    expect(hostHeaders).toContain('staging.fixture-api.example.local');
  });

  it('puts Redis and DocDB peer ingress on CacheToEcs / DocumentToEcs, not the data stacks', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureApi(), fixtureCache(), fixtureDoc()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const redis = app.node.findAll().find((node) => node instanceof RedisStack) as RedisStack | undefined;
    const cacheEdge = app.node.findAll().find((node) => node instanceof CacheToEcsStack) as CacheToEcsStack | undefined;
    const doc = app.node.findAll().find((node) => node instanceof DocDbStack) as DocDbStack | undefined;
    const docEdge = app.node
      .findAll()
      .find((node) => node instanceof DocumentToEcsStack) as DocumentToEcsStack | undefined;
    expect(redis).toBeDefined();
    expect(cacheEdge).toBeDefined();
    expect(doc).toBeDefined();
    expect(docEdge).toBeDefined();
    const cacheIngress = Template.fromStack(cacheEdge!).findResources('AWS::EC2::SecurityGroupIngress');
    expect(Object.keys(cacheIngress).length).toBeGreaterThan(0);
    expect(JSON.stringify(cacheIngress)).toMatch(/6379/);
    expect(JSON.stringify(cacheIngress)).toMatch(/ImportValue/);
    expect(Object.keys(Template.fromStack(docEdge!).findResources('AWS::EC2::SecurityGroupIngress')).length).toBeGreaterThan(
      0,
    );
  });

  it('does not emit a network load balancer for HTTP-only managed-host', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureApi()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stacks = app.node.findAll().filter((node) => typeof (node as { stackName?: string }).stackName === 'string');
    for (const node of stacks) {
      try {
        const template = Template.fromStack(node as never);
        const nlb = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')).filter(
          (resource) => (resource as { Properties?: { Type?: string } }).Properties?.Type === 'network',
        );
        expect(nlb).toEqual([]);
      } catch {
        // non-stack nodes
      }
    }
  });
});

const mqttWsApi = (): ResolvedCloudComponent =>
  fixtureApi({
    metadata: {
      ...fixtureApi().metadata,
      hostname: 'staging-fixture-api.example.local',
      protocols: ['mqtt', 'ws'],
      extras: { protocols: ['mqtt', 'ws'] },
    },
  });

const fixtureDb = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-db-database',
  component: 'fixture-db',
  env: 'staging',
  strategy: 'database',
  construct: 'RdsPostgresInstance',
  scope: 'service',
  requires: [],
  metadata: {
    extras: { engine: 'postgres' },
    engine: 'postgres',
  },
});

const fixtureTemporal = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-temporal-worker',
  component: 'fixture-temporal',
  env: 'staging',
  strategy: 'worker',
  construct: 'TemporalServer',
  scope: 'service',
  requires: [],
  metadata: {
    extras: {},
  },
});

const fixtureTemporalUi = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-temporal-ui-runtime',
  component: 'fixture-temporal-ui',
  env: 'staging',
  strategy: 'runtime',
  construct: 'ECSFargateService',
  scope: 'service',
  requires: [],
  metadata: {
    runtimeType: 'ecs-fargate',
    ports: [8080],
    exposed: true,
    hostname: 'staging-fixture-temporal-ui.example.local',
    routing: 'alb',
    certificateArn: certArn,
    extras: {},
  },
});

const workshopNames = /api-nest|api-go|web-angular|tm-user-count|queue-mqtt/;

const createApp = (components: ResolvedCloudComponent[]) =>
  createCdkApp({
    env: 'staging',
    graph: emptyGraph(),
    resolution: { components, resources: [] },
    imageTag: 'latest',
    accountId: env.account,
    region: env.region,
  });

const collectNetworkLbs = (app: ReturnType<typeof createCdkApp>) => {
  const found: unknown[] = [];
  for (const node of app.node.findAll()) {
    try {
      const template = Template.fromStack(node as never);
      found.push(
        ...Object.values(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')).filter(
          (resource) => (resource as { Properties?: { Type?: string } }).Properties?.Type === 'network',
        ),
      );
    } catch {
      // non-stack nodes
    }
  }
  return found;
};

describe('createCdkApp second managed-host + Temporal', () => {
  it('uses a unique listener priority so same-length names do not collide', () => {
    expect(listenerRulePriority('fixture-api')).not.toBe(listenerRulePriority('fixture-temporal-ui'));
    expect(listenerRulePriority('svc-alpha')).not.toBe(listenerRulePriority('svc-omega'));
  });

  it('emits two Fargate services, 443 host-headers, RDS, Temporal, and NLB', () => {
    const app = createApp([mqttWsApi(), fixtureDb(), fixtureTemporal(), fixtureTemporalUi()]);
    const services = app.node.findAll().filter((node) => node instanceof EcsServiceStack) as EcsServiceStack[];
    const temporal = app.node.findAll().find((node) => node instanceof TemporalStack) as TemporalStack | undefined;
    const rds = app.node.findAll().find((node) => node instanceof RdsStack) as RdsStack | undefined;
    const wiring = app.node.findAll().find((node) => node instanceof EcsSharedStack) as EcsSharedStack | undefined;
    const nlb = app.node.findAll().find((node) => node instanceof NlbStack) as NlbStack | undefined;
    expect(services).toHaveLength(2);
    expect(temporal).toBeDefined();
    expect(rds).toBeDefined();
    expect(wiring).toBeDefined();
    expect(nlb).toBeDefined();

    const wiringTemplate = Template.fromStack(wiring!);
    const listeners = Object.values(wiringTemplate.findResources('AWS::ElasticLoadBalancingV2::Listener'));
    const ports = listeners.map((resource) => (resource as { Properties?: { Port?: number; Protocol?: string } }).Properties);
    expect(ports.some((listener) => listener?.Port === 443 && listener?.Protocol === 'HTTPS')).toBe(true);
    expect(ports.some((listener) => listener?.Port === 80 && listener?.Protocol === 'HTTP')).toBe(true);

    const hostHeaders: string[] = [];
    const priorities = new Set<number>();
    for (const stack of services) {
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([Match.objectLike({ Image: FARGATE_PAUSE_IMAGE })]),
      });
      const rules = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
      expect(rules).toHaveLength(1);
      const ruleJson = JSON.stringify(rules);
      expect(ruleJson).toMatch(/Https443/);
      expect(ruleJson).not.toMatch(/HttpsListener/);
      hostHeaders.push(ruleJson);
      const priority = (rules[0] as { Properties?: { Priority?: number } }).Properties?.Priority;
      expect(priority).toBeDefined();
      priorities.add(Number(priority));
    }
    expect(priorities.size).toBe(2);
    expect(hostHeaders.join()).toContain('staging-fixture-api.example.local');
    expect(hostHeaders.join()).toContain('staging-fixture-temporal-ui.example.local');

    const ui = services.find((stack) => Template.fromStack(stack).toJSON().Resources && JSON.stringify(Template.fromStack(stack).toJSON()).includes('staging-fixture-temporal-ui'));
    expect(ui).toBeDefined();
    const uiTemplate = Template.fromStack(ui!);
    uiTemplate.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'staging-fixture-temporal-ui' });
    uiTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'staging-fixture-temporal-ui',
      ContainerDefinitions: Match.arrayWith([Match.objectLike({ PortMappings: Match.arrayWith([Match.objectLike({ ContainerPort: 8080 })]) })]),
    });

    const temporalTemplate = Template.fromStack(temporal!);
    expect(temporalTemplate.findResources('AWS::ElasticLoadBalancingV2::TargetGroup')).toEqual({});
    const temporalServices = Object.values(temporalTemplate.findResources('AWS::ECS::Service'));
    for (const resource of temporalServices) {
      const loadBalancers = (resource as { Properties?: { LoadBalancers?: unknown[] } }).Properties?.LoadBalancers;
      expect(loadBalancers === undefined || loadBalancers.length === 0).toBe(true);
    }

    const nlbTemplate = Template.fromStack(nlb!);
    const targetGroups = Object.values(nlbTemplate.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'));
    expect(targetGroups.length).toBe(2);
    for (const resource of targetGroups) {
      const targets = (resource as { Properties?: { Targets?: unknown[] } }).Properties?.Targets;
      expect(targets === undefined || targets.length === 0).toBe(true);
    }

    const blobs = [...services, temporal, rds, wiring, nlb]
      .map((stack) => JSON.stringify(Template.fromStack(stack!).toJSON()))
      .join();
    expect(blobs).not.toMatch(workshopNames);
  });

  it('does not emit a network LB for HTTP-only UI + Temporal + RDS', () => {
    const app = createApp([fixtureTemporalUi(), fixtureDb(), fixtureTemporal()]);
    expect(collectNetworkLbs(app)).toEqual([]);
    const services = app.node.findAll().filter((node) => node instanceof EcsServiceStack);
    expect(services).toHaveLength(1);
  });
});

describe('EcsServiceStack rolling apply defaults', () => {
  it('synths 100/200, breaker, grace, drain, desiredCount 2, and no LoadBalancers', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', [fixtureApi()]);
    const networking = new NetworkingStack(app, 'NetRoll', { env, profile, maxAzs: 2 });
    const shared = new EcsSharedStack(app, 'WiringRoll', {
      env,
      profile,
      networking,
      enableAlb: true,
      certificateArn: certArn,
    });
    const stack = new EcsServiceStack(app, 'SvcRoll', {
      env,
      profile,
      networking,
      shared,
      component: fixtureApi(),
      repositoryName: 'unused',
      imageTag: 'latest',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
      DeploymentConfiguration: Match.objectLike({
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
      HealthCheckGracePeriodSeconds: 60,
    });
    const services = Object.values(template.findResources('AWS::ECS::Service'));
    for (const resource of services) {
      expect((resource as { Properties?: { LoadBalancers?: unknown } }).Properties).not.toHaveProperty(
        'LoadBalancers',
      );
    }
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: FARGATE_PAUSE_IMAGE,
        }),
      ]),
    });
    const pauseJson = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
    expect(pauseJson).toContain(FARGATE_PAUSE_IMAGE);
    expect(pauseJson).not.toMatch(/HealthCheck/);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'ip-stagin-fixtureapi',
      TargetType: 'ip',
      HealthCheckPath: '/',
      HealthCheckIntervalSeconds: 30,
    });
    const tgs = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'));
    const attrs = (tgs[0] as { Properties?: { TargetGroupAttributes?: Array<{ Key?: string; Value?: string }> } })
      .Properties?.TargetGroupAttributes;
    expect(attrs?.some((attr) => attr.Key === 'deregistration_delay.timeout_seconds' && attr.Value === '60')).toBe(
      true,
    );
    template.hasResourceProperties('AWS::ECS::TaskDefinition', { Cpu: '512', Memory: '1024' });
    expect(template.findResources('AWS::ApplicationAutoScaling::ScalableTarget')).toEqual({});
  });

  it('uses xs+dev cpu/memory and desiredCount 1', () => {
    const app = new App();
    const component = fixtureApi({
      metadata: { ...fixtureApi().metadata, extras: { capacity: 'xs', reliability: 'dev' } },
    });
    const profile = buildEnvProfile('staging', [component]);
    const networking = new NetworkingStack(app, 'NetXs', { env, profile, maxAzs: 2 });
    const shared = new EcsSharedStack(app, 'WiringXs', {
      env,
      profile,
      networking,
      enableAlb: true,
      certificateArn: certArn,
    });
    const stack = new EcsServiceStack(app, 'SvcXs', {
      env,
      profile,
      networking,
      shared,
      component,
      repositoryName: 'unused',
      imageTag: 'latest',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', { Cpu: '256', Memory: '512' });
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  });

  it('lets package capacity.cpu win and scales only when max > min', () => {
    const app = new App();
    const component = fixtureApi({
      metadata: {
        ...fixtureApi().metadata,
        extras: { capacity: 's', 'capacity.cpu': 1024, 'capacity.memory': 2048, 'scaling.min': 2, 'scaling.max': 4, 'scaling.metric': 'cpu' },
      },
    });
    const profile = buildEnvProfile('staging', [component]);
    const networking = new NetworkingStack(app, 'NetScale', { env, profile, maxAzs: 2 });
    const shared = new EcsSharedStack(app, 'WiringScale', {
      env,
      profile,
      networking,
      enableAlb: true,
      certificateArn: certArn,
    });
    const stack = new EcsServiceStack(app, 'SvcScale', {
      env,
      profile,
      networking,
      shared,
      component,
      repositoryName: 'unused',
      imageTag: 'latest',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', { Cpu: '1024', Memory: '2048' });
    expect(Object.keys(template.findResources('AWS::ApplicationAutoScaling::ScalableTarget')).length).toBeGreaterThan(0);
  });
});




describe('serviceLogGroup', () => {
  const build = (context?: Record<string, string>) => {
    const app = new App({ context });
    const stack = new Stack(app, 'LogStack');
    const group = serviceLogGroup(stack, 'LogGroup', '/thonnas/Staging/svc', { 'logs.retentionDays': 7 });
    return { group, template: Template.fromStack(stack) };
  };

  it('creates the named log group when it is not orphaned', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/thonnas/Staging/svc', RetentionInDays: 7 });
  });

  it('adopts an orphaned log group instead of creating a conflicting one', () => {
    const { group, template } = build({ 'ThonnasLogGroupOrphan:/thonnas/Staging/svc': 'true' });
    expect(template.findResources('AWS::Logs::LogGroup')).toEqual({});
    expect(group.logGroupName).toBe('/thonnas/Staging/svc');
  });
});

