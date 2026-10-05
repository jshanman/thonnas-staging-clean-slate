import { describe, expect, it } from '@jest/globals';
import { Template } from 'aws-cdk-lib/assertions';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { EcsServiceStack } from './ecs-service-stack';
import { TemporalStack } from './temporal-stack';
import { TemporalToEcsStack } from './temporal-to-ecs-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const certArn = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111';

const fixtureApi = (): ResolvedCloudComponent => ({
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
    projectName: 'demo',
  });

describe('TemporalToEcsStack', () => {
  it('injects the real Cloud Map DNS name into Fargate task definitions, not a static guess', () => {
    const app = createApp([fixtureTemporal(), fixtureDb(), fixtureApi()]);
    const temporal = app.node.findAll().find((node) => node instanceof TemporalStack) as TemporalStack;
    const ecs = app.node.findAll().find((node) => node instanceof EcsServiceStack);
    const edge = app.node.findAll().find((node) => node instanceof TemporalToEcsStack);
    expect(temporal).toBeDefined();
    expect(ecs).toBeDefined();
    expect(edge).toBeDefined();
    expect(temporal.internalEndpoint).toBe('fixture-temporal.demo.staging.internal:7233');

    const ecsTemplate = Template.fromStack(ecs as EcsServiceStack);
    const taskJson = JSON.stringify(ecsTemplate.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).toContain('THONNAS_TEMPORAL_ENDPOINT');
    expect(taskJson).toContain('fixture-temporal.demo.staging.internal:7233');
    // @intent Regression guard for the exact bug this stack exists to fix -- a hardcoded
    // "{project}.staging.internal" guess (built assuming the project is literally named
    // "thonnas") that silently pointed nowhere for any differently named project.
    expect(taskJson).not.toContain('thonnas.staging.internal');
  });

  it('does not invent TemporalToEcs when no Fargate peers exist', () => {
    const app = createApp([fixtureTemporal(), fixtureDb()]);
    expect(app.node.findAll().some((node) => node instanceof TemporalToEcsStack)).toBe(false);
  });

  it('does not invent TemporalToEcs when there is no Temporal component', () => {
    const app = createApp([fixtureApi()]);
    expect(app.node.findAll().some((node) => node instanceof TemporalToEcsStack)).toBe(false);
  });
});

