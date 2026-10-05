import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { createCdkApp } from '../cdk/runtime';
import { NetworkingStack } from './networking-stack';
import { RedisStack } from './redis-stack';
import { DependencyGraph, ResolvedCloudComponent } from '../types';

const env = { account: '123456789012', region: 'us-east-1' };

const fixtureCache = (overrides?: Partial<ResolvedCloudComponent>): ResolvedCloudComponent => ({
  id: 'staging-fixture-cache-cache',
  component: 'fixture-cache',
  env: 'staging',
  strategy: 'cache',
  construct: 'ElasticacheRedisCluster',
  scope: 'service',
  requires: [],
  metadata: {
    extras: { engine: 'redis', peerSecurityGroupIds: ['sg-0123456789abcdef0'] },
    engine: 'redis',
  },
  ...overrides,
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

const hasOpen6379 = (template: Template): boolean => {
  const sgs = template.findResources('AWS::EC2::SecurityGroup');
  return Object.values(sgs).some((resource) => {
    const ingress = (resource as { Properties?: { SecurityGroupIngress?: Array<Record<string, unknown>> } }).Properties
      ?.SecurityGroupIngress;
    if (!Array.isArray(ingress)) return false;
    return ingress.some((rule) => {
      const cidr = rule.CidrIp;
      const from = Number(rule.FromPort);
      const to = Number(rule.ToPort);
      const covers6379 = (!Number.isFinite(from) && !Number.isFinite(to)) || (from <= 6379 && to >= 6379);
      return covers6379 && typeof cidr === 'string' && cidr.endsWith('/0');
    });
  });
};

describe('RedisStack', () => {
  it('synthesizes a single-node Redis, secret, and SG on private subnets without an app build', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'Net', { env, profile, maxAzs: 2 });
    const stack = new RedisStack(app, 'Redis', {
      env,
      profile,
      networking,
      component: fixtureCache(),
      extras: { secretName: 'staging/fixture-cache/custom', peerSecurityGroupIds: ['sg-0123456789abcdef0'] },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 1);
    template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      Engine: 'redis',
      NumCacheClusters: 1,
      TransitEncryptionEnabled: true,
    });
    expect(template.findResources('AWS::SecretsManager::Secret')).not.toEqual({});
    expect(template.findResources('AWS::EC2::SecurityGroup')).not.toEqual({});
    expect(hasOpen6379(template)).toBe(false);
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map(
      (resource) => (resource as { Properties?: { Name?: string } }).Properties?.Name,
    );
    expect(names).toContain('staging/fixture-cache/custom');
    expect(stack.secretArn).toBeTruthy();
    expect(stack.endpoint).toBeTruthy();
  });

  it('stays 1-node on standard and maps backup days to snapshot retention', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetStd', { env, profile, maxAzs: 2 });
    const stack = new RedisStack(app, 'RedisStd', {
      env,
      profile,
      networking,
      component: fixtureCache({
        metadata: { extras: { engine: 'redis', reliability: 'standard' }, engine: 'redis' },
      }),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      NumCacheClusters: 1,
      SnapshotRetentionLimit: 7,
      AutomaticFailoverEnabled: false,
    });
  });

  it('throws when private subnets are missing', () => {
    const app = new App();
    const profile = buildEnvProfile('beta', []);
    const networking = new NetworkingStack(app, 'NetBeta', { env, profile, maxAzs: 2 });
    expect(
      () =>
        new RedisStack(app, 'RedisBeta', {
          env,
          profile,
          networking,
          component: { ...fixtureCache(), env: 'beta' },
        }),
    ).toThrow(/private subnet/i);
  });

  it('rejects engines other than redis', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetEngine', { env, profile, maxAzs: 2 });
    expect(
      () =>
        new RedisStack(app, 'RedisEngine', {
          env,
          profile,
          networking,
          component: fixtureCache(),
          extras: { engine: 'memcached' },
        }),
    ).toThrow(/engine: redis/);
  });
});

describe('createCdkApp Redis wiring', () => {
  it('synthesizes ElasticacheRedisCluster with Networking', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureCache()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stack = app.node.findAll().find((node) => node instanceof RedisStack) as RedisStack | undefined;
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);
    template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 1);
    template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      Engine: 'redis',
      NumCacheClusters: 1,
    });
  });

  it('uses metadata.extras secretName and peer SGs without a separate extras constructor arg', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: {
        components: [
          fixtureCache({
            metadata: {
              extras: {
                engine: 'redis',
                secretName: 'staging/fixture-cache/from-extras',
                peerSecurityGroupIds: ['sg-0123456789abcdef0'],
              },
              engine: 'redis',
            },
          }),
        ],
        resources: [],
      },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stack = app.node.findAll().find((node) => node instanceof RedisStack) as RedisStack | undefined;
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map(
      (resource) => (resource as { Properties?: { Name?: string } }).Properties?.Name,
    );
    expect(names).toContain('staging/fixture-cache/from-extras');
    const inlineIngress = Object.values(template.findResources('AWS::EC2::SecurityGroup')).flatMap(
      (resource) =>
        (resource as { Properties?: { SecurityGroupIngress?: Array<Record<string, unknown>> } }).Properties
          ?.SecurityGroupIngress ?? [],
    );
    const separateIngress = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map(
      (resource) => (resource as { Properties?: Record<string, unknown> }).Properties ?? {},
    );
    const ingress = [...inlineIngress, ...separateIngress];
    expect(ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          FromPort: 6379,
          ToPort: 6379,
          SourceSecurityGroupId: 'sg-0123456789abcdef0',
        }),
      ]),
    );
  });
});



