import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { RdsStack } from './rds-stack';
import { RelationalToEcsStack } from './relational-to-ecs-stack';
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

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

describe('RelationalToEcsStack', () => {
  it('injects portable RDS secrets into Fargate task definitions', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureApi(), fixtureDb()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
      projectName: 'demo',
    });
    const rds = app.node.findAll().find((node) => node instanceof RdsStack);
    const ecs = app.node.findAll().find((node) => node instanceof EcsServiceStack);
    const edge = app.node.findAll().find((node) => node instanceof RelationalToEcsStack);
    expect(rds).toBeDefined();
    expect(ecs).toBeDefined();
    expect(edge).toBeDefined();

    const edgeTemplate = Template.fromStack(edge as RelationalToEcsStack);
    expect(Object.keys(edgeTemplate.findResources('AWS::EC2::SecurityGroupIngress')).length).toBeGreaterThan(0);

    const ecsTemplate = Template.fromStack(ecs as EcsServiceStack);
    const taskJson = JSON.stringify(ecsTemplate.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).toMatch(/THONNAS_RELATIONAL_HOST/);
    expect(taskJson).toMatch(/THONNAS_RELATIONAL_PORT/);
    expect(taskJson).toMatch(/THONNAS_RELATIONAL_USERNAME/);
    expect(taskJson).toMatch(/THONNAS_RELATIONAL_PASSWORD/);
    expect(taskJson).toMatch(/THONNAS_RELATIONAL_TLS/);
    expect(taskJson).toMatch(/THONNAS_RELATIONAL_SECRET_ARN/);
    expect(taskJson).not.toMatch(/SECRET__DBT_POSTGRES/);
    expect(taskJson).not.toMatch(/DATABASE_URL/);
  });

  it('keeps vendor product DSN mapping out of the edge source', () => {
    const src = fs.readFileSync(path.join(__dirname, 'relational-to-ecs-stack.ts'), 'utf8');
    expect(src).not.toMatch(/SECRET__DBT_POSTGRES|DATABASE_URL|api-medusa|dbt-postgres/i);
    expect(src).toMatch(/THONNAS_RELATIONAL_/);
  });

  it('does not invent RelationalToEcs when no Fargate peers exist', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureDb()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    expect(app.node.findAll().some((node) => node instanceof RelationalToEcsStack)).toBe(false);
  });
});



