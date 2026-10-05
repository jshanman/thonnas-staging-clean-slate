import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { ObserveStack } from './observe-stack';
import { RdsStack } from './rds-stack';
import { RelationalToObserveStack } from './relational-to-observe-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const certArn = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111';

const fixtureDb = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-db-database',
  component: 'fixture-db',
  env: 'staging',
  strategy: 'database',
  construct: 'RdsPostgresInstance',
  scope: 'service',
  requires: [],
  metadata: { extras: { engine: 'postgres' } },
});

const fixtureDashboard = (): ResolvedCloudComponent => ({
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
    extras: { strategyKey: 'infra.observe.dashboard' },
  },
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

describe('RelationalToObserveStack', () => {
  it('injects portable postgres SQLSTORE env into dashboard only (no SIGNOZ_)', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureDb(), fixtureDashboard()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const rds = app.node.findAll().find((node) => node instanceof RdsStack);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack);
    const edge = app.node.findAll().find((node) => node instanceof RelationalToObserveStack);
    expect(rds).toBeDefined();
    expect(observe).toBeDefined();
    expect(edge).toBeDefined();

    const edgeTemplate = Template.fromStack(edge as RelationalToObserveStack);
    expect(Object.keys(edgeTemplate.findResources('AWS::EC2::SecurityGroupIngress')).length).toBe(1);

    const observeTemplate = Template.fromStack(observe as ObserveStack);
    const taskJson = JSON.stringify(observeTemplate.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).toMatch(/THONNAS_DASHBOARD_SQLSTORE/);
    expect(taskJson).toMatch(/THONNAS_DASHBOARD_PG_HOST/);
    expect(taskJson).toMatch(/THONNAS_DASHBOARD_PG_PASSWORD/);
    // @intent DB name stays package-owned (not RDS secret.dbname / thonnas)
    expect(taskJson).not.toMatch(/THONNAS_DASHBOARD_PG_DATABASE/);
    expect(taskJson).not.toMatch(/SIGNOZ_/);
    expect(taskJson).not.toMatch(/THONNAS_DASHBOARD_SQLITE/);

    const src = fs.readFileSync(path.join(__dirname, 'relational-to-observe-stack.ts'), 'utf8');
    expect(src).not.toMatch(/SIGNOZ_/);
  });
});



