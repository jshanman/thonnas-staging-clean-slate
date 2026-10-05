import { describe, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { RdsStack } from './rds-stack';
import { DocDbStack } from './docdb-stack';
import { RedisStack } from './redis-stack';
import { ResolvedCloudComponent } from '../types';

const env = { account: '123456789012', region: 'us-east-1' };

const fixture = (construct: string): ResolvedCloudComponent => ({
  id: `staging-fixture-${construct}`,
  component: 'fixture-data',
  env: 'staging',
  strategy: 'database',
  construct,
  scope: 'service',
  requires: [],
  metadata: {},
});

describe('data-plane stacks', () => {
  it('synthesizes RDS Postgres', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'Net', { env, profile, maxAzs: 2 });
    const stack = new RdsStack(app, 'Rds', { env, profile, networking, component: fixture('RdsPostgresInstance') });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
  });

  it('synthesizes a single DocumentDB instance', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'Net2', { env, profile, maxAzs: 2 });
    const stack = new DocDbStack(app, 'Doc', { env, profile, networking, component: fixture('AwsDocumentDbCluster') });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::DocDB::DBCluster', 1);
  });

  it('synthesizes Redis', () => {
    const app = new App();
    const profile = buildEnvProfile('staging', []);
    const networking = new NetworkingStack(app, 'Net3', { env, profile, maxAzs: 2 });
    const stack = new RedisStack(app, 'Redis', {
      env,
      profile,
      networking,
      component: fixture('ElasticacheRedisCluster'),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 1);
  });
});



