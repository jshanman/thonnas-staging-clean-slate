import { describe, expect, it } from '@jest/globals';
import { Template } from 'aws-cdk-lib/assertions';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { EcsServiceStack } from './ecs-service-stack';
import { EcsSharedStack } from './ecs-shared-stack';
import { NlbStack } from './nlb-stack';
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

const hasOpen7233 = (template: Template): boolean => {
  const groups = template.findResources('AWS::EC2::SecurityGroup');
  return Object.values(groups).some((resource) => {
    const ingress = (resource as { Properties?: { SecurityGroupIngress?: Array<Record<string, unknown>> } }).Properties
      ?.SecurityGroupIngress;
    if (!Array.isArray(ingress)) return false;
    return ingress.some((rule) => {
      const cidr = rule.CidrIp;
      const from = Number(rule.FromPort);
      const to = Number(rule.ToPort);
      const covers7233 = (!Number.isFinite(from) && !Number.isFinite(to)) || (from <= 7233 && to >= 7233);
      return covers7233 && (cidr === '0.0.0.0/0' || cidr === '::/0');
    });
  });
};

const workshopNames = /api-nest|api-go|web-angular|tm-user-count|queue-mqtt/;

describe('createCdkApp Temporal', () => {
  it('emits Temporal Fargate, RDS, Wiring, and NLB when Temporal is listed before RDS', () => {
    const app = createApp([fixtureTemporal(), fixtureDb(), mqttWsApi()]);
    const temporal = app.node.findAll().find((node) => node instanceof TemporalStack) as TemporalStack | undefined;
    const rds = app.node.findAll().find((node) => node instanceof RdsStack) as RdsStack | undefined;
    const wiring = app.node.findAll().find((node) => node instanceof EcsSharedStack) as EcsSharedStack | undefined;
    const service = app.node.findAll().find((node) => node instanceof EcsServiceStack) as EcsServiceStack | undefined;
    const nlb = app.node.findAll().find((node) => node instanceof NlbStack) as NlbStack | undefined;
    expect(temporal).toBeDefined();
    expect(rds).toBeDefined();
    expect(wiring).toBeDefined();
    expect(service).toBeDefined();
    expect(nlb).toBeDefined();
    expect(temporal!.serviceName).toBe('staging-fixture-temporal');

    const temporalTemplate = Template.fromStack(temporal!);
    temporalTemplate.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'staging-fixture-temporal',
    });
    temporalTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'staging-fixture-temporal',
    });
    temporalTemplate.hasOutput('ServiceName', { Value: 'staging-fixture-temporal' });

    const taskJson = JSON.stringify(temporalTemplate.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).toContain('POSTGRES_PWD');
    expect(taskJson).toContain(':password::');
    expect(taskJson).toContain('POSTGRES_SEEDS');
    expect(taskJson).toContain('DBNAME');
    expect(taskJson).not.toContain('from-secret');
    expect(taskJson).toContain('temporalio/auto-setup:1.25.2');

    const envEntries = Object.values(temporalTemplate.findResources('AWS::ECS::TaskDefinition')).flatMap((resource) => {
      const defs = (resource as { Properties?: { ContainerDefinitions?: Array<{ Environment?: Array<{ Name?: string }> }> } })
        .Properties?.ContainerDefinitions;
      return defs?.flatMap((def) => def.Environment ?? []) ?? [];
    });
    const secretEntries = Object.values(temporalTemplate.findResources('AWS::ECS::TaskDefinition')).flatMap((resource) => {
      const defs = (resource as { Properties?: { ContainerDefinitions?: Array<{ Secrets?: Array<{ Name?: string }> }> } })
        .Properties?.ContainerDefinitions;
      return defs?.flatMap((def) => def.Secrets ?? []) ?? [];
    });
    // @intent Only credentials come from Secrets Manager; host/port/dbname are plain env vars
    expect(envEntries.some((entry) => entry.Name === 'POSTGRES_PWD')).toBe(false);
    expect(envEntries.some((entry) => entry.Name === 'POSTGRES_SEEDS')).toBe(true);
    // temporalio/auto-setup's wait/schema-setup scripts read DB_PORT, not POSTGRES_PORT
    expect(envEntries.some((entry) => entry.Name === 'DB_PORT')).toBe(true);
    expect(envEntries.some((entry) => entry.Name === 'DBNAME')).toBe(true);
    expect(secretEntries.some((entry) => entry.Name === 'POSTGRES_USER')).toBe(true);
    expect(secretEntries.some((entry) => entry.Name === 'POSTGRES_PWD')).toBe(true);
    expect(secretEntries.some((entry) => entry.Name === 'POSTGRES_SEEDS')).toBe(false);

    expect(hasOpen7233(temporalTemplate)).toBe(false);
    // @intent Classic Service Discovery (A records); never tagged AmazonECSManaged, which lets
    // ECS's task-set cleanup delete this CloudFormation-owned registry
    const registries = Object.values(temporalTemplate.findResources('AWS::ServiceDiscovery::Service'));
    expect(registries).toHaveLength(1);
    expect(JSON.stringify(registries[0])).toContain('"Type":"A"');
    expect(JSON.stringify(temporalTemplate.toJSON())).not.toContain('AmazonECSManaged');
    const services = Object.values(temporalTemplate.findResources('AWS::ECS::Service'));
    for (const resource of services) {
      const loadBalancers = (resource as { Properties?: { LoadBalancers?: unknown[] } }).Properties?.LoadBalancers;
      expect(loadBalancers === undefined || loadBalancers.length === 0).toBe(true);
    }
    expect(temporalTemplate.findResources('AWS::ElasticLoadBalancingV2::TargetGroup')).toEqual({});

    const nlbTemplate = Template.fromStack(nlb!);
    const targetGroups = Object.values(nlbTemplate.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'));
    expect(targetGroups.length).toBe(2);
    for (const resource of targetGroups) {
      const targets = (resource as { Properties?: { Targets?: unknown[] } }).Properties?.Targets;
      expect(targets === undefined || targets.length === 0).toBe(true);
    }

    const blobs = [temporal, rds, wiring, nlb, service]
      .map((stack) => JSON.stringify(Template.fromStack(stack!).toJSON()))
      .join();
    expect(blobs).not.toMatch(workshopNames);
  });

  it('omits Temporal when there is no relational secret', () => {
    const app = createApp([fixtureTemporal(), mqttWsApi()]);
    const temporal = app.node.findAll().filter((node) => node instanceof TemporalStack);
    expect(temporal).toHaveLength(0);
  });

  it('sizes the Temporal worker from the capacity table', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: {
        components: [
          {
            ...fixtureTemporal(),
            metadata: { extras: { capacity: 'xs', reliability: 'dev' } },
          },
          fixtureDb(),
          mqttWsApi(),
        ],
        resources: [],
      },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const temporal = app.node.findAll().find((node) => node instanceof TemporalStack) as TemporalStack | undefined;
    expect(temporal).toBeDefined();
    const template = Template.fromStack(temporal!);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', { Cpu: '256', Memory: '512' });
  });
});




