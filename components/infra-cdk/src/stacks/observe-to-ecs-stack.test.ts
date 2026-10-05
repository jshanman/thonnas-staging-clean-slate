import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { EcsServiceStack } from './ecs-service-stack';
import { ObserveStack, observeCollectorName } from './observe-stack';
import { ObserveToEcsStack } from './observe-to-ecs-stack';

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

const fixtureObserve = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-observe-metrics',
  component: 'fixture-observe',
  env: 'staging',
  strategy: 'metrics',
  construct: 'ObserveIngest',
  scope: 'service',
  requires: [],
  metadata: {
    extras: { strategyKey: 'infra.observe.metrics' },
    certificateArn: certArn,
  },
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

describe('ObserveToEcsStack', () => {
  it('emits edge peer ingress and Service Connect via createCdkApp', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureApi(), fixtureObserve()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const edge = app.node.findAll().find((node) => node instanceof ObserveToEcsStack) as
      | ObserveToEcsStack
      | undefined;
    const observe = app.node.findAll().find((node) => node instanceof ObserveStack) as ObserveStack | undefined;
    const ecs = app.node.findAll().filter((node) => node instanceof EcsServiceStack);
    expect(edge).toBeDefined();
    expect(observe).toBeDefined();
    expect(ecs).toHaveLength(1);

    const edgeTemplate = Template.fromStack(edge!);
    const ingress = edgeTemplate.findResources('AWS::EC2::SecurityGroupIngress');
    expect(Object.keys(ingress).length).toBeGreaterThanOrEqual(2);
    const ingressJson = JSON.stringify(ingress);
    expect(ingressJson).toMatch(/4317|4318/);

    const observeTemplate = Template.fromStack(observe!);
    const services = observeTemplate.findResources('AWS::ECS::Service');
    const collector = Object.values(services).find(
      (resource) => resource.Properties?.ServiceName === observeCollectorName('staging', 'fixture-observe'),
    ) as {
      Properties?: {
        ServiceConnectConfiguration?: { Services?: Array<{ PortName?: string; DiscoveryName?: string }> };
      };
    };
    const published = collector?.Properties?.ServiceConnectConfiguration?.Services ?? [];
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          PortName: 'otlp-http',
          DiscoveryName: observeCollectorName('staging', 'fixture-observe'),
        }),
        expect.objectContaining({
          PortName: 'otlp-grpc',
          DiscoveryName: `${observeCollectorName('staging', 'fixture-observe')}-grpc`,
        }),
      ]),
    );
  });

  it('does not emit ObserveToEcs for dashboard-only packages', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: {
        components: [
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
              extras: { strategyKey: 'infra.observe.dashboard' },
            },
          },
        ],
        resources: [],
      },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    expect(app.node.findAll().some((node) => node instanceof ObserveToEcsStack)).toBe(false);
    expect(app.node.findAll().some((node) => node instanceof ObserveStack)).toBe(true);
  });

  it('keeps edge source free of SIGNOZ_ / ObserveSignoz product strings', () => {
    const src = fs.readFileSync(path.join(__dirname, 'observe-to-ecs-stack.ts'), 'utf8');
    expect(src).not.toMatch(/SIGNOZ_/);
    expect(src).not.toMatch(/ObserveSignoz/);
    expect(src).not.toMatch(/signoz/i);
    const edgeTemplateBlob = JSON.stringify(
      Template.fromStack(
        (() => {
          const app = createCdkApp({
            env: 'staging',
            graph: emptyGraph(),
            resolution: { components: [fixtureApi(), fixtureObserve()], resources: [] },
            imageTag: 'latest',
            accountId: env.account,
            region: env.region,
          });
          return app.node.findAll().find((node) => node instanceof ObserveToEcsStack) as ObserveToEcsStack;
        })(),
      ).toJSON(),
    );
    expect(edgeTemplateBlob).not.toMatch(/SIGNOZ_/);
    expect(edgeTemplateBlob).not.toMatch(/ObserveSignoz/);
  });
});



