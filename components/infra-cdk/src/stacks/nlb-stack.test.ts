import { describe, expect, it } from '@jest/globals';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, ResolvedCloudComponent } from '../types';
import { EcsServiceStack } from './ecs-service-stack';
import { EcsSharedStack } from './ecs-shared-stack';
import { NlbStack, uniqueEdgePorts } from './nlb-stack';

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

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

const mqttWsApi = (): ResolvedCloudComponent =>
  fixtureApi({
    metadata: {
      ...fixtureApi().metadata,
      protocols: ['mqtt', 'ws'],
      extras: { protocols: ['mqtt', 'ws'] },
    },
  });

describe('uniqueEdgePorts', () => {
  it('maps mqtt and ws to 1883 and 8083 and dedupes tcp onto 1883', () => {
    expect(uniqueEdgePorts(['mqtt', 'ws'])).toEqual([1883, 8083]);
    expect(uniqueEdgePorts(['mqtt', 'tcp', 'ws'])).toEqual([1883, 8083]);
    expect(uniqueEdgePorts(['unknown', 'http'])).toEqual([]);
  });
});

describe('createCdkApp NLB edge', () => {
  it('emits a network LB with empty TGs and keeps Wiring plus Fargate', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [mqttWsApi()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const nlb = app.node.findAll().find((node) => node instanceof NlbStack) as NlbStack | undefined;
    const wiring = app.node.findAll().find((node) => node instanceof EcsSharedStack) as EcsSharedStack | undefined;
    const service = app.node.findAll().find((node) => node instanceof EcsServiceStack) as EcsServiceStack | undefined;
    expect(nlb).toBeDefined();
    expect(wiring).toBeDefined();
    expect(service).toBeDefined();
    expect(nlb!.listenerPorts).toEqual([1883, 8083, 8084]);

    const nlbTemplate = Template.fromStack(nlb!);
    nlbTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'network',
      Scheme: 'internet-facing',
    });
    nlbTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 1883,
      Protocol: 'TCP',
    });
    nlbTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 8083,
      Protocol: 'TCP',
    });
    // @intent Browsers refuse ws:// from an https:// page (mixed content); the NLB terminates TLS
    // on ws-port+1 using the same wildcard cert the ALB uses, forwarding decrypted traffic to the
    // existing plaintext ws (8083) target group -- no separate target group for 8084.
    nlbTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 8084,
      Protocol: 'TLS',
      Certificates: [{ CertificateArn: certArn }],
    });
    const targetGroups = Object.values(nlbTemplate.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'));
    expect(targetGroups.length).toBe(2);
    for (const resource of targetGroups) {
      const targets = (resource as { Properties?: { Targets?: unknown[] } }).Properties?.Targets;
      expect(targets === undefined || targets.length === 0).toBe(true);
    }
    nlbTemplate.hasOutput('NlbDnsName', Match.anyValue());
    nlbTemplate.hasOutput('NlbListenerPorts', { Value: '1883,8083,8084' });

    const synthesized = JSON.stringify(nlbTemplate.toJSON());
    expect(synthesized).toContain('Tg1883');
    expect(synthesized).toContain('L1883');
    expect(synthesized).toContain('Tg8083');
    expect(synthesized).toContain('L8083');
    expect(synthesized).toContain('LWss');

    const wiringTemplate = Template.fromStack(wiring!);
    const albListeners = Object.values(wiringTemplate.findResources('AWS::ElasticLoadBalancingV2::Listener'));
    const ports = albListeners.map(
      (resource) => (resource as { Properties?: { Port?: number; Protocol?: string } }).Properties,
    );
    expect(ports.some((listener) => listener?.Port === 443 && listener?.Protocol === 'HTTPS')).toBe(true);
    expect(ports.some((listener) => listener?.Port === 80)).toBe(true);

    const serviceTemplate = Template.fromStack(service!);
    const hostHeaders = JSON.stringify(serviceTemplate.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
    expect(hostHeaders).toContain('staging-fixture-api.example.local');
  });

  it('does not emit a network load balancer for HTTP-only managed-host', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureApi()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const nlb = app.node.findAll().find((node) => node instanceof NlbStack);
    expect(nlb).toBeUndefined();
    expect(app.node.findAll().some((node) => node instanceof EcsServiceStack)).toBe(true);
    const stacks = app.node.findAll().filter((node) => typeof (node as { stackName?: string }).stackName === 'string');
    for (const node of stacks) {
      try {
        const template = Template.fromStack(node as never);
        const networkLbs = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')).filter(
          (resource) => (resource as { Properties?: { Type?: string } }).Properties?.Type === 'network',
        );
        expect(networkLbs).toEqual([]);
      } catch {
        // non-stack nodes
      }
    }
  });
});




