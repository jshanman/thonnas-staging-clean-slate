import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { resolvePortableExtras } from '../release/portable-extras';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { EcsServiceStack, FARGATE_PAUSE_IMAGE, listenerRulePriority } from './ecs-service-stack';
import { EcsSharedStack } from './ecs-shared-stack';
import { NlbStack } from './nlb-stack';
import {
  ObserveStack,
  OBSERVE_COLLECTOR_IMAGE,
  observeCollectorEndpoint,
  observeCollectorName,
  observeDashboardName,
  observeFamiliesFromSlots,
} from './observe-stack';
import { RdsStack } from './rds-stack';
import { TemporalStack } from './temporal-stack';

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
    hostname: 'staging-fixture-api.example.local',
    routing: 'alb',
    certificateArn: certArn,
    extras: {},
  },
  ...overrides,
});

const mqttWsApi = (): ResolvedCloudComponent =>
  fixtureApi({
    metadata: {
      ...fixtureApi().metadata,
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

const fixtureObserve = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-observe-observe',
  component: 'fixture-observe',
  env: 'staging',
  strategy: 'observe',
  construct: 'ObserveIngest',
  scope: 'service',
  requires: [],
  metadata: {
    hostname: 'staging-fixture-observe.example.local',
    certificateArn: certArn,
    extras: {},
  },
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

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

const hasOpenOtlp = (template: Template): boolean => {
  const groups = template.findResources('AWS::EC2::SecurityGroup');
  return Object.values(groups).some((resource) => {
    const ingress = (resource as { Properties?: { SecurityGroupIngress?: Array<Record<string, unknown>> } }).Properties
      ?.SecurityGroupIngress;
    if (!Array.isArray(ingress)) return false;
    return ingress.some((rule) => {
      const cidr = rule.CidrIp;
      const from = Number(rule.FromPort);
      const to = Number(rule.ToPort);
      const coversOtlp =
        (!Number.isFinite(from) && !Number.isFinite(to)) ||
        (from <= 4317 && to >= 4317) ||
        (from <= 4318 && to >= 4318);
      return coversOtlp && (cidr === '0.0.0.0/0' || cidr === '::/0');
    });
  });
};

const workshopNames = /api-nest|api-go|web-angular|tm-user-count|queue-mqtt/;

describe('createCdkApp Observe', () => {
  it('emits ObserveStack, two managed-host services, Https443 host-headers, RDS, Temporal, and NLB', () => {
    const app = createApp([mqttWsApi(), fixtureDb(), fixtureTemporal(), fixtureTemporalUi(), fixtureObserve()]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    const services = app.node.findAll().filter((node) => node instanceof EcsServiceStack) as EcsServiceStack[];
    const temporal = app.node.findAll().find((node) => node instanceof TemporalStack) as TemporalStack | undefined;
    const rds = app.node.findAll().find((node) => node instanceof RdsStack) as RdsStack | undefined;
    const wiring = app.node.findAll().find((node) => node instanceof EcsSharedStack) as EcsSharedStack | undefined;
    const nlb = app.node.findAll().find((node) => node instanceof NlbStack) as NlbStack | undefined;
    expect(observe).toBeDefined();
    expect(services).toHaveLength(2);
    expect(temporal).toBeDefined();
    expect(rds).toBeDefined();
    expect(wiring).toBeDefined();
    expect(nlb).toBeDefined();

    const observeTemplate = Template.fromStack(observe!);
    observeTemplate.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeCollectorName('staging', 'fixture-observe'),
    });
    observeTemplate.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeDashboardName('staging', 'fixture-observe'),
    });
    observeTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: observeCollectorName('staging', 'fixture-observe'),
    });
    observeTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: observeDashboardName('staging', 'fixture-observe'),
      ContainerDefinitions: Match.arrayWith([Match.objectLike({ Image: FARGATE_PAUSE_IMAGE })]),
    });
    const taskJson = JSON.stringify(observeTemplate.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).toContain(FARGATE_PAUSE_IMAGE);
    expect(taskJson).not.toMatch(/otel\/opentelemetry-collector/);
    expect(hasOpenOtlp(observeTemplate)).toBe(false);

    const observeServices = Object.values(observeTemplate.findResources('AWS::ECS::Service'));
    for (const resource of observeServices) {
      const loadBalancers = (resource as { Properties?: { LoadBalancers?: unknown[] } }).Properties?.LoadBalancers;
      expect(loadBalancers === undefined || loadBalancers.length === 0).toBe(true);
    }

    const observeRules = Object.values(observeTemplate.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
    expect(observeRules).toHaveLength(1);
    const observeRuleJson = JSON.stringify(observeRules);
    expect(observeRuleJson).toMatch(/Https443/);
    expect(observeRuleJson).not.toMatch(/HttpsListener/);
    expect(observeRuleJson).toContain('staging-fixture-observe.example.local');
    const observePriority = (observeRules[0] as { Properties?: { Priority?: number } }).Properties?.Priority;
    expect(observePriority).toBe(listenerRulePriority('fixture-observe'));
    expect(observePriority).not.toBe(80);

    const hostHeaders: string[] = [];
    const priorities = new Set<number>();
    for (const stack of services) {
      const template = Template.fromStack(stack);
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
    priorities.add(Number(observePriority));
    expect(priorities.size).toBe(3);
    expect(hostHeaders.join()).toContain('staging-fixture-api.example.local');
    expect(hostHeaders.join()).toContain('staging-fixture-temporal-ui.example.local');

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

    const blobs = [...services, observe, temporal, rds, wiring, nlb]
      .map((stack) => JSON.stringify(Template.fromStack(stack!).toJSON()))
      .join();
    expect(blobs).not.toMatch(workshopNames);
    expect(blobs).not.toContain('{env}.{component}');
  });

  it('does not emit a network LB for observe-only + Temporal + RDS', () => {
    const app = createApp([fixtureObserve(), fixtureDb(), fixtureTemporal()]);
    expect(collectNetworkLbs(app)).toEqual([]);
    const observe = app.node.findAll().filter((node) => node instanceof ObserveStack);
    expect(observe).toHaveLength(1);
  });

  it('uses unique listener priorities so observe does not collide with managed-host', () => {
    expect(listenerRulePriority('fixture-observe')).not.toBe(listenerRulePriority('fixture-api'));
    expect(listenerRulePriority('fixture-observe')).not.toBe(listenerRulePriority('fixture-temporal-ui'));
    expect(listenerRulePriority('fixture-observe')).not.toBe(80);
  });

  it('emits collector only for a metrics-only package', () => {
    const app = createApp([
      {
        ...fixtureObserve(),
        id: 'staging-fixture-observe-metrics',
        strategy: 'metrics',
        metadata: { extras: {}, certificateArn: certArn },
      },
    ]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    expect(observe).toBeDefined();
    const template = Template.fromStack(observe!);
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeCollectorName('staging', 'fixture-observe'),
      DesiredCount: 1,
      DeploymentConfiguration: Match.objectLike({
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
    });
    const names = Object.values(template.findResources('AWS::ECS::Service')).map(
      (resource) => (resource as { Properties?: { ServiceName?: string } }).Properties?.ServiceName,
    );
    expect(names).toEqual([observeCollectorName('staging', 'fixture-observe')]);
    expect(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup')).toEqual({});
    expect(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).toEqual({});
    const collectorTaskJson = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
    expect(collectorTaskJson).toContain(FARGATE_PAUSE_IMAGE);
    expect(collectorTaskJson).not.toMatch(/HealthCheck/);
    expect(collectorTaskJson).not.toMatch(/otel\/opentelemetry-collector/);
  });

  it('creates its own ECR repository, same component-agnostic pattern as EcsServiceStack (pause->release needs somewhere real to push)', () => {
    const app = createApp([
      {
        ...fixtureObserve(),
        id: 'staging-fixture-observe-metrics',
        strategy: 'metrics',
        metadata: { extras: {}, certificateArn: certArn },
      },
    ]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    expect(observe).toBeDefined();
    Template.fromStack(observe!).hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'staging-fixture-observe',
    });
  });

  it('treats collector slot and strategyKey as metrics-only (not both families)', () => {
    expect(
      observeFamiliesFromSlots([
        {
          ...fixtureObserve(),
          strategy: 'collector',
          metadata: { extras: { strategyKey: 'infra.observe.metrics' } },
        },
      ]),
    ).toEqual({ collector: true, dashboard: false });
    expect(
      observeFamiliesFromSlots([
        {
          ...fixtureObserve(),
          strategy: 'collector',
          metadata: { extras: {} },
        },
      ]),
    ).toEqual({ collector: true, dashboard: false });
  });

  it('does not inject metastore SQLSTORE on ObserveStack (edge owns postgres)', () => {
    const app = createApp([
      {
        ...fixtureObserve(),
        metadata: {
          ...fixtureObserve().metadata,
          extras: resolvePortableExtras({
            env: 'staging',
            extras: { capacity: 'xs', reliability: 'dev' },
          }),
        },
      },
    ]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    const template = Template.fromStack(observe!);
    const taskJson = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).not.toContain('THONNAS_DASHBOARD_SQLSTORE');
    expect(taskJson).not.toContain('THONNAS_DASHBOARD_SQLITE');
    expect(taskJson).toContain('THONNAS_ENV');
  });

  it('emits dashboard only for a dashboard-only package with an empty TG', () => {
    const app = createApp([
      {
        id: 'staging-fixture-dashboard-dashboard',
        component: 'fixture-dashboard',
        env: 'staging',
        strategy: 'dashboard',
        construct: 'ObserveIngest',
        scope: 'service',
        requires: [],
        metadata: {
          hostname: 'staging-fixture-dashboard.example.local',
          certificateArn: certArn,
          extras: {},
        },
      },
    ]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    expect(observe).toBeDefined();
    const template = Template.fromStack(observe!);
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeDashboardName('staging', 'fixture-dashboard'),
      DesiredCount: 2,
    });
    const dashTaskJson = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
    expect(dashTaskJson).toContain(FARGATE_PAUSE_IMAGE);
    expect(dashTaskJson).not.toMatch(/HealthCheck/);
    const names = Object.values(template.findResources('AWS::ECS::Service')).map(
      (resource) => (resource as { Properties?: { ServiceName?: string } }).Properties?.ServiceName,
    );
    expect(names).toEqual([observeDashboardName('staging', 'fixture-dashboard')]);
    const services = Object.values(template.findResources('AWS::ECS::Service'));
    for (const resource of services) {
      expect((resource as { Properties?: { LoadBalancers?: unknown } }).Properties).not.toHaveProperty(
        'LoadBalancers',
      );
    }
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'ip-staging-fixture-dashboard-das',
      TargetType: 'ip',
    });
    expect(Object.keys(template.findResources('AWS::EC2::SecurityGroupIngress')).length).toBeGreaterThan(0);
    const rules = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
    expect(rules).toHaveLength(1);
    expect(JSON.stringify(rules)).toContain('staging-fixture-dashboard.example.local');
  });

  it('emits both families when a combined package declares metrics and dashboard', () => {
    const app = createApp([
      {
        ...fixtureObserve(),
        id: 'staging-fixture-observe-metrics',
        strategy: 'metrics',
        metadata: { extras: {}, certificateArn: certArn },
      },
      {
        ...fixtureObserve(),
        id: 'staging-fixture-observe-dashboard',
        strategy: 'dashboard',
        metadata: {
          hostname: 'staging-fixture-observe.example.local',
          certificateArn: certArn,
          extras: {},
        },
      },
    ]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    expect(observe).toBeDefined();
    const template = Template.fromStack(observe!);
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeCollectorName('staging', 'fixture-observe'),
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeDashboardName('staging', 'fixture-observe'),
    });
    expect(Object.keys(template.findResources('AWS::ECS::Service'))).toHaveLength(2);
  });

  it('sizes collector and dashboard from s+standard and keeps collector desiredCount 1', () => {
    const extras = resolvePortableExtras({ env: 'staging', extras: { capacity: 's', reliability: 'standard' } });
    const app = createApp([
      {
        ...fixtureObserve(),
        metadata: { ...fixtureObserve().metadata, extras },
      },
    ]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    expect(observe).toBeDefined();
    const template = Template.fromStack(observe!);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', { Cpu: '512', Memory: '1024' });
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeCollectorName('staging', 'fixture-observe'),
      DesiredCount: 1,
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeDashboardName('staging', 'fixture-observe'),
      DesiredCount: 2,
    });
    const taskJson = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).not.toContain('THONNAS_DASHBOARD_SQLSTORE');
  });

  it('keeps collector desiredCount 1 after planner-expanded extras', () => {
    const extras = resolvePortableExtras({ env: 'staging', extras: {} });
    const app = createApp([
      {
        ...fixtureObserve(),
        metadata: { ...fixtureObserve().metadata, extras },
      },
    ]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    const template = Template.fromStack(observe!);
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeCollectorName('staging', 'fixture-observe'),
      DesiredCount: 1,
    });
  });

  it('uses pause as apply placeholder; release image comes from package/fixture', () => {
    expect(OBSERVE_COLLECTOR_IMAGE).toBe(FARGATE_PAUSE_IMAGE);
    expect(OBSERVE_COLLECTOR_IMAGE).not.toMatch(/signoz/i);
    expect(OBSERVE_COLLECTOR_IMAGE).not.toMatch(/otel\/opentelemetry-collector/);
    expect(observeCollectorEndpoint('staging', 'fixture-observe')).toBe(
      'http://staging-fixture-observe-collector:4318',
    );
  });

  it('keeps Service Connect authorship on ObserveToEcs, not ObserveStack source', () => {
    const observeSrc = fs.readFileSync(path.join(__dirname, 'observe-stack.ts'), 'utf8');
    const edgeSrc = fs.readFileSync(path.join(__dirname, 'observe-to-ecs-stack.ts'), 'utf8');
    expect(observeSrc).not.toMatch(/serviceConnectConfiguration/);
    expect(edgeSrc).toMatch(/serviceConnectConfiguration/);
    const app = createApp([fixtureObserve()]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    const template = Template.fromStack(observe!);
    const services = template.findResources('AWS::ECS::Service');
    const collector = Object.values(services).find(
      (resource) => resource.Properties?.ServiceName === observeCollectorName('staging', 'fixture-observe'),
    ) as { Properties?: { ServiceConnectConfiguration?: { Services?: unknown[] } } };
    expect(collector?.Properties?.ServiceConnectConfiguration?.Services?.length).toBeGreaterThan(0);
  });

  it('keeps observe tasks free of store env and without SIGNOZ_ keys', () => {
    const app = createApp([fixtureObserve()]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    const template = Template.fromStack(observe!);
    const taskJson = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).not.toMatch(/THONNAS_COLUMNAR_/);
    expect(taskJson).not.toContain('THONNAS_DASHBOARD_SQLSTORE');
    expect(taskJson).not.toMatch(/SIGNOZ_/);
    expect(taskJson).not.toContain('/var/lib/signoz');
    expect(JSON.stringify(template.findOutputs('*'))).toMatch(/CollectorEndpoint|4318/);
  });

  it('grants ECR pull on collector and dashboard execution roles', () => {
    const app = createApp([fixtureObserve()]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    const template = Template.fromStack(observe!);
    const policies = JSON.stringify(template.findResources('AWS::IAM::ManagedPolicy'));
    const roles = JSON.stringify(template.findResources('AWS::IAM::Role'));
    expect(`${policies}${roles}`).toContain('AmazonEC2ContainerRegistryReadOnly');
  });

  it('raises collector desiredCount only when the package originally set scaling.min', () => {
    const app = createApp([
      {
        ...fixtureObserve(),
        metadata: {
          ...fixtureObserve().metadata,
          extras: { 'scaling.min': 3 },
        },
      },
    ]);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    const template = Template.fromStack(observe!);
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeCollectorName('staging', 'fixture-observe'),
      DesiredCount: 3,
    });
  });
});



