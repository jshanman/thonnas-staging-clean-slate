import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { DbaFleetStack } from './dba-fleet-stack';
import { DbaFleetToObserveStack } from './dba-fleet-to-observe-stack';
import { ObserveStack } from './observe-stack';

const env = { account: '123456789012', region: 'us-east-1' };

const fixtureDbaFleet = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-dba-fleet',
  component: 'fixture-dba-fleet',
  env: 'staging',
  strategy: 'fleet',
  construct: 'DbaFleet',
  scope: 'service',
  requires: [],
  metadata: {
    extras: { peerSecurityGroupIds: ['sg-0123456789abcdef0'], servicePorts: [8123, 9000] },
  },
});

const fixtureObserveMetrics = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-observe-metrics',
  component: 'fixture-observe',
  env: 'staging',
  strategy: 'metrics',
  construct: 'ObserveIngest',
  scope: 'service',
  requires: [],
  metadata: { extras: { strategyKey: 'infra.observe.metrics' } },
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

describe('DbaFleetToObserveStack', () => {
  it('owns peer SG ingress and injects portable fleet env (no product keys)', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureDbaFleet(), fixtureObserveMetrics()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const fleet = app.node.findAll().find((node) => node instanceof DbaFleetStack);
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack);
    const edge = app.node.findAll().find((node) => node instanceof DbaFleetToObserveStack);
    expect(fleet).toBeDefined();
    expect(observe).toBeDefined();
    expect(edge).toBeDefined();

    const edgeTemplate = Template.fromStack(edge as DbaFleetToObserveStack);
    expect(Object.keys(edgeTemplate.findResources('AWS::EC2::SecurityGroupIngress')).length).toBeGreaterThan(0);

    const observeTemplate = Template.fromStack(observe as ObserveStack);
    const taskJson = JSON.stringify(observeTemplate.findResources('AWS::ECS::TaskDefinition'));
    expect(taskJson).toMatch(/THONNAS_DBA_FLEET_HOST/);
    expect(taskJson).toMatch(/THONNAS_DBA_FLEET_SECRET_ARN/);
    expect(taskJson).toMatch(/THONNAS_DBA_FLEET_VOLUME_PATH/);
    expect(taskJson).toMatch(/THONNAS_DBA_FLEET_PASSWORD/);
    expect(taskJson).not.toMatch(/THONNAS_COLUMNAR_/);
    expect(taskJson).not.toMatch(/SIGNOZ_/);

    const src = fs.readFileSync(path.join(__dirname, 'dba-fleet-to-observe-stack.ts'), 'utf8');
    expect(src).not.toMatch(/SIGNOZ_/);
    expect(src).not.toMatch(/clickhouse\.com/);
    expect(src).not.toMatch(/THONNAS_COLUMNAR_/);
  });
});



