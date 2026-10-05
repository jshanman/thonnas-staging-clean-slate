import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { createCdkApp } from '../cdk/runtime';
import { NetworkingStack } from './networking-stack';
import { DbaFleetStack } from './dba-fleet-stack';
import { DbaFleetToObserveStack } from './dba-fleet-to-observe-stack';
import { DependencyGraph, ResolvedCloudComponent } from '../types';

const env = { account: '123456789012', region: 'us-east-1' };

const fixtureDbaFleet = (extras?: Record<string, unknown>): ResolvedCloudComponent => ({
  id: 'staging-fixture-dba-fleet',
  component: 'fixture-dba-fleet',
  env: 'staging',
  strategy: 'fleet',
  construct: 'DbaFleet',
  scope: 'service',
  requires: [],
  metadata: {
    extras: extras ?? { peerSecurityGroupIds: ['sg-0123456789abcdef0'], servicePorts: [8123, 9000] },
  },
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

const hasOpenFleetPorts = (template: Template): boolean => {
  const sgs = template.findResources('AWS::EC2::SecurityGroup');
  return Object.values(sgs).some((resource) => {
    const ingress = (resource as { Properties?: { SecurityGroupIngress?: Array<Record<string, unknown>> } }).Properties
      ?.SecurityGroupIngress;
    if (!Array.isArray(ingress)) return false;
    return ingress.some((rule) => {
      const cidr = rule.CidrIp;
      return cidr === '0.0.0.0/0' || cidr === '::/0';
    });
  });
};

describe('DbaFleetStack', () => {
  it('synthesizes private EC2, secret, bootstrap userdata, and DbaFleet outputs', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetFleet', { env, profile, maxAzs: 2 });
    const stack = new DbaFleetStack(app, 'Fleet', {
      env,
      profile,
      networking,
      component: fixtureDbaFleet({
        secretName: 'staging/fixture-dba-fleet/dba-fleet',
        peerSecurityGroupIds: ['sg-0123456789abcdef0'],
        servicePorts: [8123, 9000],
        bootstrapUrl: 'https://example.invalid/thonnas-dba-bootstrap.sh',
      }),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EC2::Instance', 1);
    expect(template.findResources('AWS::SecretsManager::Secret')).not.toEqual({});
    expect(hasOpenFleetPorts(template)).toBe(false);
    const userData = JSON.stringify(template.findResources('AWS::EC2::Instance'));
    expect(userData).toMatch(/thonnas-dba-bootstrap|BOOTSTRAP_URL|no extras\.bootstrapUrl/);
    expect(userData).not.toMatch(/clickhouse\.com/);
    const blob = JSON.stringify(template.toJSON());
    expect(blob).not.toMatch(/clickhouse\.com/);
    expect(blob).not.toMatch(/metrics-otel-signoz/);
    const outputs = template.findOutputs('*');
    expect(JSON.stringify(outputs)).toMatch(/DbaFleetSecretArn|DbaFleetHost|DbaFleetVolumePath/);
  });

  it('emits no-bootstrap message when bootstrapUrl is omitted', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetFleetNoBoot', { env, profile, maxAzs: 2 });
    const stack = new DbaFleetStack(app, 'FleetNoBoot', {
      env,
      profile,
      networking,
      component: fixtureDbaFleet({ peerSecurityGroupIds: ['sg-0123456789abcdef0'] }),
    });
    const userData = JSON.stringify(Template.fromStack(stack).findResources('AWS::EC2::Instance'));
    expect(userData).toMatch(/no extras\.bootstrapUrl/);
    expect(userData).not.toMatch(/clickhouse\.com/);
  });

  it('honors protect.fromDelete and backup.retentionDays on standard', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetFleetStd', { env, profile, maxAzs: 2 });
    const stack = new DbaFleetStack(app, 'FleetStd', {
      env,
      profile,
      networking,
      component: fixtureDbaFleet({
        reliability: 'standard',
        'protect.fromDelete': true,
        'backup.retentionDays': 14,
        peerSecurityGroupIds: ['sg-0123456789abcdef0'],
      }),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::EC2::Instance', { DisableApiTermination: true });
    expect(JSON.stringify(template.toJSON())).toMatch(/backup\.retentionDays/);
  });

  it('emits fleet plus collector with DbaFleetToObserve peer edge', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: {
        components: [
          fixtureDbaFleet(),
          {
            id: 'staging-fixture-observe-metrics',
            component: 'fixture-observe',
            env: 'staging',
            strategy: 'metrics',
            construct: 'ObserveIngest',
            scope: 'service',
            requires: [],
            metadata: { extras: { strategyKey: 'infra.observe.metrics' } },
          },
        ],
        resources: [],
      },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const fleet = app.node.findAll().find((node) => node instanceof DbaFleetStack) as DbaFleetStack;
    const edge = app.node.findAll().find((node) => node instanceof DbaFleetToObserveStack);
    const observe = app.node
      .findAll()
      .find((node) => (node as { constructor: { name: string } }).constructor.name === 'ObserveStack');
    expect(fleet).toBeDefined();
    expect(observe).toBeDefined();
    expect(edge).toBeDefined();
    const edgeTemplate = Template.fromStack(edge as never);
    expect(JSON.stringify(edgeTemplate.findResources('AWS::EC2::SecurityGroupIngress'))).toMatch(/9000|8123/);
    const observeTemplate = Template.fromStack(observe as never);
    expect(JSON.stringify(observeTemplate.findResources('AWS::ECS::TaskDefinition'))).not.toMatch(
      /THONNAS_COLUMNAR_/,
    );
  });

  it('emits fleet-only from createCdkApp with Networking', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureDbaFleet()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stacks = app.node.findAll().filter((node) => node instanceof DbaFleetStack);
    expect(stacks).toHaveLength(1);
    expect(app.node.findAll().some((node) => node instanceof NetworkingStack)).toBe(true);
  });
});



