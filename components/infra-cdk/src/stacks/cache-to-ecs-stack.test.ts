import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { RedisStack } from './redis-stack';
import { CacheToEcsStack } from './cache-to-ecs-stack';
import { EcsServiceStack } from './ecs-service-stack';

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

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

describe('CacheToEcsStack', () => {
  it('injects portable cache host/password into Fargate task definitions', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureApi(), fixtureCache()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
      projectName: 'demo',
    });
    const redis = app.node.findAll().find((node) => node instanceof RedisStack);
    const ecs = app.node.findAll().find((node) => node instanceof EcsServiceStack);
    const edge = app.node.findAll().find((node) => node instanceof CacheToEcsStack);
    expect(redis).toBeDefined();
    expect(ecs).toBeDefined();
    expect(edge).toBeDefined();
    expect((edge as CacheToEcsStack).dependencies.some((dep) => dep === ecs)).toBe(true);

    const edgeTemplate = Template.fromStack(edge as CacheToEcsStack);
    expect(Object.keys(edgeTemplate.findResources('AWS::EC2::SecurityGroupIngress')).length).toBeGreaterThan(0);

    const ecsTemplate = Template.fromStack(ecs as EcsServiceStack);
    const taskJson = JSON.stringify(ecsTemplate.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).toMatch(/THONNAS_CACHE_HOST/);
    expect(taskJson).toMatch(/THONNAS_CACHE_PORT/);
    expect(taskJson).toMatch(/THONNAS_CACHE_PASSWORD/);
    expect(taskJson).toMatch(/THONNAS_CACHE_TLS/);
    expect(taskJson).toMatch(/THONNAS_CACHE_SECRET_ARN/);
    expect(taskJson).not.toMatch(/REDIS_URL|CACHE_REDIS|api-medusa/i);
  });

  it('keeps vendor product DSN mapping out of the edge source', () => {
    const src = fs.readFileSync(path.join(__dirname, 'cache-to-ecs-stack.ts'), 'utf8');
    expect(src).not.toMatch(/REDIS_URL|CACHE_REDIS|api-medusa|cache-redis/i);
    expect(src).toMatch(/THONNAS_CACHE_/);
  });

  it('does not invent CacheToEcs when no Fargate peers exist', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureCache()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    expect(app.node.findAll().some((node) => node instanceof CacheToEcsStack)).toBe(false);
  });
});



