import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { EcsSharedStack } from './ecs-shared-stack';
import { ResolvedCloudComponent } from '../types';

const env = { account: '123456789012', region: 'us-east-1' };
const certArn = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111';

const fargateComponent = (): ResolvedCloudComponent => ({
  id: 'staging-fixture-api-runtime',
  component: 'fixture-api',
  env: 'staging',
  strategy: 'runtime',
  construct: 'ECSFargateService',
  scope: 'service',
  requires: [],
  metadata: { runtimeType: 'ecs-fargate', ports: [3000], exposed: true },
});

describe('EcsSharedStack', () => {
  it('synthesizes HTTPS 443 and HTTP redirect when a cert is set for staging Fargate', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', [fargateComponent()]);
    const networking = new NetworkingStack(app, 'Net', { env, profile, maxAzs: 2 });
    const stack = new EcsSharedStack(app, 'Wiring', {
      env,
      profile,
      networking,
      enableAlb: true,
      certificateArn: certArn,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
    expect(template.findResources('AWS::ServiceDiscovery::PrivateDnsNamespace')).not.toEqual({});
    template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'thonnas.staging.internal',
    });
    // @intent Container Insights stays off by default (custom metrics Free Tier)
    const clusters = Object.values(template.findResources('AWS::ECS::Cluster')) as Array<{
      Properties?: { ClusterSettings?: Array<{ Name?: string; Value?: string }> };
    }>;
    expect(clusters).toHaveLength(1);
    const insights = clusters[0].Properties?.ClusterSettings?.find((s) => s.Name === 'containerInsights');
    expect(insights?.Value ?? 'disabled').toBe('disabled');
    const loadBalancers = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'));
    expect(loadBalancers.every((resource) => (resource as { Properties?: { Type?: string } }).Properties?.Type !== 'network')).toBe(
      true,
    );
  });

  it('throws when staging Fargate ALB has no certificateArn and no rootDomain', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', [fargateComponent()]);
    const networking = new NetworkingStack(app, 'NetNoCert', { env, profile, maxAzs: 2 });
    expect(
      () =>
        new EcsSharedStack(app, 'WiringNoCert', {
          env,
          profile,
          networking,
          enableAlb: true,
        }),
    ).toThrow(/certificateArn/);
  });

  it('requests a DNS-validated wildcard cert when no certificateArn is supplied but rootDomain is', () => {
    const rootDomain = 'burner1.example.test';
    const app = new App({
      context: {
        [`hosted-zone:account=${env.account}:domainName=${rootDomain}:privateZone=false`]: {
          Id: '/hostedzone/ZTESTWILDCARD',
          Name: `${rootDomain}.`,
        },
      },
    });
    const profile = buildEnvProfile('staging', [fargateComponent()]);
    const networking = new NetworkingStack(app, 'NetAutoCert', { env, profile, maxAzs: 2 });
    const stack = new EcsSharedStack(app, 'WiringAutoCert', {
      env,
      profile,
      networking,
      enableAlb: true,
      rootDomain,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: `*.${rootDomain}`,
      ValidationMethod: 'DNS',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });

  it('opts into Container Insights when containerInsights is true', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', [fargateComponent()]);
    const networking = new NetworkingStack(app, 'NetInsights', { env, profile, maxAzs: 2 });
    const stack = new EcsSharedStack(app, 'WiringInsights', {
      env,
      profile,
      networking,
      enableAlb: true,
      certificateArn: certArn,
      containerInsights: true,
    });
    const clusters = Object.values(Template.fromStack(stack).findResources('AWS::ECS::Cluster')) as Array<{
      Properties?: { ClusterSettings?: Array<{ Name?: string; Value?: string }> };
    }>;
    const insights = clusters[0].Properties?.ClusterSettings?.find((s) => s.Name === 'containerInsights');
    expect(insights?.Value).toBe('enabled');
  });
});



