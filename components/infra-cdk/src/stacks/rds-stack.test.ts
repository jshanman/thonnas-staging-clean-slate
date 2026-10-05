import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { createCdkApp } from '../cdk/runtime';
import { NetworkingStack } from './networking-stack';
import { RdsStack } from './rds-stack';
import { DependencyGraph, ResolvedCloudComponent } from '../types';

const env = { account: '123456789012', region: 'us-east-1' };

const fixtureDb = (overrides?: Partial<ResolvedCloudComponent>): ResolvedCloudComponent => ({
  id: 'staging-fixture-db-database',
  component: 'fixture-db',
  env: 'staging',
  strategy: 'database',
  construct: 'RdsPostgresInstance',
  scope: 'service',
  requires: [],
  metadata: {
    extras: { engine: 'postgres', peerSecurityGroupIds: ['sg-0123456789abcdef0'] },
    engine: 'postgres',
  },
  ...overrides,
});

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

const hasOpen5432 = (template: Template): boolean => {
  const sgs = template.findResources('AWS::EC2::SecurityGroup');
  return Object.values(sgs).some((resource) => {
    const ingress = (resource as { Properties?: { SecurityGroupIngress?: Array<Record<string, unknown>> } }).Properties
      ?.SecurityGroupIngress;
    if (!Array.isArray(ingress)) return false;
    return ingress.some((rule) => {
      const cidr = rule.CidrIp;
      const from = Number(rule.FromPort);
      const to = Number(rule.ToPort);
      const covers5432 = (!Number.isFinite(from) && !Number.isFinite(to)) || (from <= 5432 && to >= 5432);
      return covers5432 && (cidr === '0.0.0.0/0' || cidr === '::/0');
    });
  });
};

describe('RdsStack', () => {
  it('synthesizes instance, secret, and SG on private subnets without an app build', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'Net', { env, profile, maxAzs: 2 });
    const stack = new RdsStack(app, 'Rds', {
      env,
      profile,
      networking,
      component: fixtureDb(),
      extras: { secretName: 'staging/fixture-db/custom', peerSecurityGroupIds: ['sg-0123456789abcdef0'] },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', { PubliclyAccessible: false });
    expect(template.findResources('AWS::SecretsManager::Secret')).not.toEqual({});
    expect(template.findResources('AWS::EC2::SecurityGroup')).not.toEqual({});
    expect(template.findResources('AWS::RDS::DBSubnetGroup')).not.toEqual({});
    expect(hasOpen5432(template)).toBe(false);
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map(
      (resource) => (resource as { Properties?: { Name?: string } }).Properties?.Name,
    );
    expect(names).toContain('staging/fixture-db/custom');
  });

  it('throws when private subnets are missing', () => {
    const app = new App();
    const profile = buildEnvProfile('beta', []);
    const networking = new NetworkingStack(app, 'NetBeta', { env, profile, maxAzs: 2 });
    expect(
      () =>
        new RdsStack(app, 'RdsBeta', {
          env,
          profile,
          networking,
          component: { ...fixtureDb(), env: 'beta' },
        }),
    ).toThrow(/private subnet/i);
  });

  it('rejects non-postgres engines', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetEngine', { env, profile, maxAzs: 2 });
    expect(
      () =>
        new RdsStack(app, 'RdsEngine', {
          env,
          profile,
          networking,
          component: fixtureDb(),
          extras: { engine: 'mysql' },
        }),
    ).toThrow(/engine: postgres/);
  });
});

describe('createCdkApp RDS wiring', () => {
  it('synthesizes RdsPostgresInstance with Networking', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: { components: [fixtureDb()], resources: [] },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stack = app.node.findAll().find((node) => node instanceof RdsStack) as RdsStack | undefined;
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
  });

  it('uses metadata.extras secretName and peer SGs without a separate extras constructor arg', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: {
        components: [
          fixtureDb({
            metadata: {
              extras: {
                engine: 'postgres',
                secretName: 'staging/fixture-db/from-extras',
                peerSecurityGroupIds: ['sg-0123456789abcdef0'],
              },
              engine: 'postgres',
            },
          }),
        ],
        resources: [],
      },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
    });
    const stack = app.node.findAll().find((node) => node instanceof RdsStack) as RdsStack | undefined;
    expect(stack).toBeDefined();
    const template = Template.fromStack(stack!);
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map(
      (resource) => (resource as { Properties?: { Name?: string } }).Properties?.Name,
    );
    expect(names).toContain('staging/fixture-db/from-extras');
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
          FromPort: 5432,
          ToPort: 5432,
          SourceSecurityGroupId: 'sg-0123456789abcdef0',
        }),
      ]),
    );
  });

  it('applies standard protect, backup, and multi-AZ', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetStd', { env, profile, maxAzs: 2 });
    const stack = new RdsStack(app, 'RdsStd', {
      env,
      profile,
      networking,
      component: fixtureDb({
        metadata: { extras: { engine: 'postgres', reliability: 'standard' }, engine: 'postgres' },
      }),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: true,
      MultiAZ: true,
      BackupRetentionPeriod: 7,
    });
  });

  it('leaves dev unprotected and single-AZ', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'NetDev', { env, profile, maxAzs: 2 });
    const stack = new RdsStack(app, 'RdsDev', {
      env,
      profile,
      networking,
      component: fixtureDb({
        metadata: { extras: { engine: 'postgres', reliability: 'dev' }, engine: 'postgres' },
      }),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: false,
      MultiAZ: false,
    });
  });

  it('does not emit a DB instance for AuroraPostgresCluster', () => {
    expect(() =>
      createCdkApp({
        env: 'staging',
        graph: emptyGraph(),
        resolution: {
          components: [{ ...fixtureDb(), construct: 'AuroraPostgresCluster' }],
          resources: [],
        },
        imageTag: 'latest',
        accountId: env.account,
        region: env.region,
      }),
    ).toThrow(/AuroraPostgresCluster is not implemented/);
  });
});



