import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { createCdkApp } from '../cdk/runtime';
import { NetworkingStack } from './networking-stack';
import { DocDbStack } from './docdb-stack';
import { DependencyGraph, ResolvedCloudComponent } from '../types';

const env = { account: '123456789012', region: 'us-east-1' };

const fixtureDoc = (overrides?: Partial<ResolvedCloudComponent>): ResolvedCloudComponent => ({
  id: 'staging-fixture-doc-database',
  component: 'fixture-doc',
  env: 'staging',
  strategy: 'database',
  construct: 'AwsDocumentDbCluster',
  scope: 'service',
  requires: [],
  metadata: {
    extras: { engine: 'mongodb-compatible', peerSecurityGroupIds: ['sg-0123456789abcdef0'] },
    engine: 'mongodb-compatible',
  },
  ...overrides,
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

const hasOpen27017 = (template: Template): boolean => {
  const sgs = template.findResources('AWS::EC2::SecurityGroup');
  return Object.values(sgs).some((resource) => {
    const ingress = (resource as { Properties?: { SecurityGroupIngress?: Array<Record<string, unknown>> } }).Properties
      ?.SecurityGroupIngress;
    if (!Array.isArray(ingress)) return false;
    return ingress.some((rule) => {
      const cidr = rule.CidrIp;
      const from = Number(rule.FromPort);
      const to = Number(rule.ToPort);
      const covers27017 = (!Number.isFinite(from) && !Number.isFinite(to)) || (from <= 27017 && to >= 27017);
      return covers27017 && (cidr === '0.0.0.0/0' || cidr === '::/0');
    });
  });
};

describe('DocDbStack', () => {
  it('synthesizes a single-instance cluster, secret, and SG on private subnets without an app build', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'Net', { env, profile, maxAzs: 2 });
    const stack = new DocDbStack(app, 'Doc', {
      env,
      profile,
      networking,
      component: fixtureDoc(),
      extras: {
        secretName: 'staging/fixture-doc/custom',
        peerSecurityGroupIds: ['sg-0123456789abcdef0'],
        reliability: 'dev',
      },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::DocDB::DBCluster', 1);
    template.hasResourceProperties('AWS::DocDB::DBCluster', {});
    expect(template.findResources('AWS::DocDB::DBInstance')).not.toEqual({});
    expect(Object.keys(template.findResources('AWS::DocDB::DBInstance'))).toHaveLength(1);
    expect(template.findResources('AWS::SecretsManager::Secret')).not.toEqual({});
    expect(template.findResources('AWS::EC2::SecurityGroup')).not.toEqual({});
    expect(hasOpen27017(template)).toBe(false);
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map(
      (resource) => (resource as { Properties?: { Name?: string } }).Properties?.Name,
    );
    expect(names).toContain('staging/fixture-doc/custom');
    expect(stack.secretArn).toBeTruthy();
    expect(stack.clusterEndpoint).toBeTruthy();
  });

  it('throws when private subnets are missing', () => {
    const app = new App();
    const profile = buildEnvProfile('beta', []);
    const networking = new NetworkingStack(app, 'NetBeta', { env, profile, maxAzs: 2 });
    expect(
      () =>
        new DocDbStack(app, 'DocBeta', {
          env,
          profile,
          networking,
          component: { ...fixtureDoc(), env: 'beta' },
        }),
    ).toThrow(/private subnet/i);
  });

  it('applies standard protect, backup, and a second instance', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetStd', { env, profile, maxAzs: 2 });
    const stack = new DocDbStack(app, 'DocStd', {
      env,
      profile,
      networking,
      component: fixtureDoc({
        metadata: { extras: { engine: 'mongodb-compatible', reliability: 'standard' }, engine: 'mongodb-compatible' },
      }),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DocDB::DBCluster', {
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
    });
    expect(Object.keys(template.findResources('AWS::DocDB::DBInstance'))).toHaveLength(2);
  });

  it('rejects engines other than mongodb-compatible', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetEngine', { env, profile, maxAzs: 2 });
    expect(
      () =>
        new DocDbStack(app, 'DocEngine', {
          env,
          profile,
          networking,
          component: fixtureDoc(),
          extras: { engine: 'mongodb' },
        }),
    ).toThrow(/engine: mongodb-compatible/);
  });
});

describe('createCdkApp DocumentDB wiring', () => {
  it('synthesizes AwsDocumentDbCluster with Networking', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureDoc()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stack = app.node.findAll().find((node) => node instanceof DocDbStack) as DocDbStack | undefined;
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);
    template.resourceCountIs('AWS::DocDB::DBCluster', 1);
  });

  it('uses metadata.extras secretName and peer SGs without a separate extras constructor arg', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: {
        components: [
          fixtureDoc({
            metadata: {
              extras: {
                engine: 'mongodb-compatible',
                secretName: 'staging/fixture-doc/from-extras',
                peerSecurityGroupIds: ['sg-0123456789abcdef0'],
              },
              engine: 'mongodb-compatible',
            },
          }),
        ],
        resources: [],
      },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stack = app.node.findAll().find((node) => node instanceof DocDbStack) as DocDbStack | undefined;
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map(
      (resource) => (resource as { Properties?: { Name?: string } }).Properties?.Name,
    );
    expect(names).toContain('staging/fixture-doc/from-extras');
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
          FromPort: 27017,
          ToPort: 27017,
          SourceSecurityGroupId: 'sg-0123456789abcdef0',
        }),
      ]),
    );
  });
});



