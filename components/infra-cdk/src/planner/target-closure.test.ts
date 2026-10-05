import { describe, expect, it } from '@jest/globals';
import { DeploymentIntent, ResolvedCloudComponent } from '../types';
import { resolveTargetClosure, selectTargetIntents } from './target-closure';

const service = (component: string, construct: string, runtimeType?: string): ResolvedCloudComponent => ({
  id: `staging-${component}`,
  component,
  env: 'staging',
  strategy: 'runtime',
  construct,
  scope: 'service',
  requires: [],
  metadata: runtimeType ? { runtimeType: runtimeType as 'ecs-fargate' } : {},
});

const resolution = {
  components: [
    service('dbt-postgres', 'RdsPostgresInstance'),
    service('dbt-mongo', 'AwsDocumentDbCluster'),
    service('cache-redis', 'ElasticacheRedisCluster'),
    service('dba-clickhouse', 'DbaFleet'),
    service('worker-manager-temporal', 'TemporalServer'),
    service('dashboard-signoz', 'ObserveIngest'),
    service('api-nest', 'ECSFargateService', 'ecs-fargate'),
    service('web-a', 'ComposeHostEc2'),
    service('web-b', 'ComposeHostEc2'),
  ],
  resources: [],
};

const intent = (component: string, componentPath = `components/${component}`): DeploymentIntent =>
  ({ component, componentPath }) as DeploymentIntent;

describe('resolveTargetClosure', () => {
  it('pulls the relational provider into a Temporal target', () => {
    expect([...resolveTargetClosure(resolution, ['worker-manager-temporal'])].sort()).toEqual([
      'dbt-postgres',
      'worker-manager-temporal',
    ]);
  });

  it('pulls every data plane an ECS peer is wired to, but not unrelated services', () => {
    expect([...resolveTargetClosure(resolution, ['api-nest'])].sort()).toEqual([
      'api-nest',
      'cache-redis',
      'dbt-mongo',
      'dbt-postgres',
    ]);
  });

  it('pulls metastore and DBA fleet into an observe target', () => {
    expect([...resolveTargetClosure(resolution, ['dashboard-signoz'])].sort()).toEqual([
      'dashboard-signoz',
      'dba-clickhouse',
      'dbt-postgres',
    ]);
  });

  it('keeps every compose-host peer so the shared ComposeHost stack is not truncated', () => {
    expect([...resolveTargetClosure(resolution, ['web-a'])].sort()).toEqual(['web-a', 'web-b']);
  });

  it('leaves a provider-only target alone', () => {
    expect([...resolveTargetClosure(resolution, ['dbt-postgres'])]).toEqual(['dbt-postgres']);
  });
});

describe('selectTargetIntents', () => {
  it('keeps the closure and installed libs, drops other packages', () => {
    const intents = [
      intent('api-nest'),
      intent('dbt-postgres'),
      intent('worker-manager-temporal'),
      intent('cicd-github-actions', '.thonnas/libs/cicd-github-actions'),
    ];
    expect(selectTargetIntents(intents, resolution, ['worker-manager-temporal']).map((i) => i.component)).toEqual([
      'dbt-postgres',
      'worker-manager-temporal',
      'cicd-github-actions',
    ]);
  });
});

