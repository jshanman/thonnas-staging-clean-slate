import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { createCdkApp } from '../cdk/runtime';
import { NetworkingStack } from './networking-stack';
import { MqttFleetStack } from './mqtt-fleet-stack';
import { NlbStack } from './nlb-stack';
import { DependencyGraph, ResolvedCloudComponent } from '../types';

const env = { account: '123456789012', region: 'us-east-1' };

const fixtureMqttFleet = (extras?: Record<string, unknown>): ResolvedCloudComponent => ({
  id: 'staging-fixture-mqtt-fleet',
  component: 'fixture-mqtt-fleet',
  env: 'staging',
  strategy: 'fleet',
  construct: 'MqttFleet',
  scope: 'service',
  requires: [],
  metadata: {
    extras: extras ?? { peerSecurityGroupIds: ['sg-0123456789abcdef0'], servicePorts: [1883, 8083] },
    protocols: ['mqtt', 'ws'],
  },
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

describe('MqttFleetStack', () => {
  it('synthesizes staging default node count (reliability=standard -> scaling.min=2)', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetMqttFleet', { env, profile, maxAzs: 2 });
    const stack = new MqttFleetStack(app, 'MqttFleet', {
      env,
      profile,
      networking,
      component: fixtureMqttFleet({
        peerSecurityGroupIds: ['sg-0123456789abcdef0'],
        servicePorts: [1883, 8083],
        bootstrapUrl: 'https://example.invalid/thonnas-mqtt-bootstrap.sh',
      }),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EC2::Instance', 2);
    expect(template.findResources('AWS::SecretsManager::Secret')).not.toEqual({});
    const userData = JSON.stringify(template.findResources('AWS::EC2::Instance'));
    expect(userData).toMatch(/thonnas-mqtt-bootstrap|BOOTSTRAP_URL|no extras\.bootstrapUrl/);
    expect(userData).toMatch(/THONNAS_MQTT_FLEET_ID/);
    const outputs = template.findOutputs('*');
    expect(JSON.stringify(outputs)).toMatch(/MqttFleetSecretArn|MqttFleetHost|MqttFleetNodeCount|MqttFleetNodeIps/);
  });

  it('grants the instance role read access to the separate frontend-password secret', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetMqttFleetFrontend', { env, profile, maxAzs: 2 });
    const stack = new MqttFleetStack(app, 'MqttFleetFrontend', {
      env,
      profile,
      networking,
      component: fixtureMqttFleet(),
    });
    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Policy');
    expect(JSON.stringify(policies)).toContain('staging/fixture-mqtt-fleet/QUEUE_MQTT_FRONTEND_PASSWORD');
  });

  it('honors an explicit scaling.min=1 override (single-node fleet)', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetMqttFleetSingle', { env, profile, maxAzs: 2 });
    const stack = new MqttFleetStack(app, 'MqttFleetSingle', {
      env,
      profile,
      networking,
      component: fixtureMqttFleet({
        'scaling.min': 1,
        'scaling.max': 1,
        peerSecurityGroupIds: ['sg-0123456789abcdef0'],
        servicePorts: [1883, 8083],
      }),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EC2::Instance', 1);
  });

  it('synthesizes N nodes from scaling.min and wires peer ingress between them', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetMqttFleetCluster', { env, profile, maxAzs: 2 });
    const stack = new MqttFleetStack(app, 'MqttFleetCluster', {
      env,
      profile,
      networking,
      component: fixtureMqttFleet({
        'scaling.min': 3,
        servicePorts: [1883, 8083],
      }),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EC2::Instance', 3);
    template.hasOutput('MqttFleetNodeCount', { Value: '3' });
    const sgs = JSON.stringify(template.findResources('AWS::EC2::SecurityGroupIngress'));
    expect(sgs).toMatch(/1883/);
    expect(sgs).toMatch(/8083/);
    // @intent gen_rpc (actual cross-node message routing) is a distinct port range from Erlang
    // distribution (4371-4380) -- regression guard for a real bug this range fixed live: cluster
    // membership looked healthy with only distribution open, but publish on one node silently
    // never reached a subscriber on another.
    expect(sgs).toMatch(/5370/);
  });

  it('clamps scaling.min above the max node count', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetMqttFleetClamp', { env, profile, maxAzs: 2 });
    const stack = new MqttFleetStack(app, 'MqttFleetClamp', {
      env,
      profile,
      networking,
      component: fixtureMqttFleet({ 'scaling.min': 99 }),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EC2::Instance', 5);
  });

  it('registers fleet node IPs as real NLB targets via createCdkApp', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: {
        components: [fixtureMqttFleet({ 'scaling.min': 2, servicePorts: [1883, 8083] })],
        resources: [],
      },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const nlb = app.node.findAll().find((node) => node instanceof NlbStack) as NlbStack;
    expect(nlb).toBeDefined();
    const nlbTemplate = Template.fromStack(nlb);
    const targetGroups = nlbTemplate.findResources('AWS::ElasticLoadBalancingV2::TargetGroup');
    const blob = JSON.stringify(targetGroups);
    // @intent Empty TGs (no Targets property at all) would mean the old always-refusing behavior
    expect(blob).toMatch(/"Targets"/);
  });

  it('emits fleet-only from createCdkApp with Networking', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureMqttFleet()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stacks = app.node.findAll().filter((node) => node instanceof MqttFleetStack);
    expect(stacks).toHaveLength(1);
    expect(app.node.findAll().some((node) => node instanceof NetworkingStack)).toBe(true);
  });
});

