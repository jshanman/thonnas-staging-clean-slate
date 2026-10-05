/**
 * Cheap plan/apply matrix (AC-7.2, AC-7.8). No live AWS.
 *
 * Families (columns): website, signed-url, artifact, ecs, rds, docdb, redis,
 * temporal, observe, dba-fleet. Keep the observe column name (L-124).
 *
 * Adding a new stack later requires a new family column plus empty /
 * second-apply / missing-stack / add-component rows.
 */
import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { resolveExistingState } from './existing-state';
import {
  classifyStackRows,
  formatMatrixFailure,
  formatPlanSummaryLines,
  listPlannedStacks,
} from './stack-status';
import { StrategyResolutionResult, ResolvedCloudComponent, PlannedResource } from '../types';
import { resolvePortableExtras } from '../release/portable-extras';
import { buildEnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from '../stacks/networking-stack';
import { RedisStack } from '../stacks/redis-stack';
import { DocDbStack } from '../stacks/docdb-stack';
import { ArtifactStack } from '../stacks/artifact-stack';
import { ObserveStack, observeCollectorName } from '../stacks/observe-stack';
import { EcsSharedStack } from '../stacks/ecs-shared-stack';

const MATRIX_FAMILIES = [
  'website',
  'signed-url',
  'artifact',
  'ecs',
  'rds',
  'docdb',
  'redis',
  'temporal',
  'observe',
  'dba-fleet',
] as const;

const env = { account: '123456789012', region: 'us-east-1' };
const certArn = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111';

const component = (
  construct: string,
  name: string,
  extras?: Record<string, unknown>,
  more?: Partial<ResolvedCloudComponent['metadata']>,
): ResolvedCloudComponent => ({
  id: `staging-${name}`,
  component: name,
  env: 'staging',
  strategy: 'slot',
  construct,
  scope: 'service',
  requires: [],
  metadata: { extras: extras ?? {}, ...more },
});

const resource = (kind: PlannedResource['kind'], name: string, bucket?: string): PlannedResource => ({
  id: `${kind}-${name}`,
  kind,
  component: name,
  env: 'staging',
  scope: 'service',
  props: bucket ? { bucket } : {},
});

const resolutionFor = (components: ResolvedCloudComponent[], resources: PlannedResource[] = []): StrategyResolutionResult => ({
  components,
  resources,
});

const fullGraph = (): StrategyResolutionResult =>
  resolutionFor(
    [
      component('ECSFargateService', 'fixture-api', {}, { runtimeType: 'ecs-fargate', routing: 'alb', certificateArn: certArn }),
      component('RdsPostgresInstance', 'fixture-db', { engine: 'postgres', reliability: 'standard' }),
      component('AwsDocumentDbCluster', 'fixture-doc', { reliability: 'standard' }),
      component('ElasticacheRedisCluster', 'fixture-cache', { reliability: 'standard' }),
      component('TemporalServer', 'fixture-temporal'),
      component('DbaFleet', 'fixture-dba-fleet'),
      component('ObserveIngest', 'fixture-observe', { strategyKey: 'infra.observe.metrics' }),
      {
        ...component('ObserveIngest', 'fixture-dashboard', { strategyKey: 'infra.observe.dashboard' }),
        strategy: 'dashboard',
      },
      component('StorageTempUrlApi', 'fixture-signed-url'),
      component('ArtifactDeploy', 'fixture-artifact'),
      component('StaticSite', 'fixture-web'),
    ],
    [
      resource('s3ArtifactDeployment', 'fixture-artifact', 'p5-artifact-bucket'),
      resource('s3StaticSiteDeployment', 'fixture-web', 'p5-web-bucket'),
      resource('storageTempUrlApi', 'fixture-signed-url'),
    ],
  );

describe('plan matrix cheap slice', () => {
  it('covers every family column with empty / second-apply / missing-stack / add-component', () => {
    const resolution = fullGraph();
    const planned = listPlannedStacks(resolution, 'staging');
    const families = new Set(planned.map((row) => row.family));
    for (const family of MATRIX_FAMILIES) {
      expect(families.has(family)).toBe(true);
    }
    expect(families.has('dba-fleet')).toBe(true);

    const empty = classifyStackRows(planned, resolveExistingState({ certStatus: 'issued' }), resolution, 'staging');
    for (const family of MATRIX_FAMILIES) {
      const row = empty.rows.find((item) => item.family === family);
      if (row?.status !== 'create') {
        throw new Error(formatMatrixFailure(`empty:${family}`, row?.stackId ?? 'missing', `expected create got ${row?.status}`));
      }
    }

    const existingNames = planned.map((row) => row.stackId);
    const second = classifyStackRows(
      planned,
      resolveExistingState({ existingStackNames: existingNames, certStatus: 'issued', wouldChange: false }),
      resolution,
      'staging',
    );
    for (const family of MATRIX_FAMILIES) {
      const row = second.rows.find((item) => item.family === family);
      if (row?.status !== 'unchanged') {
        throw new Error(
          formatMatrixFailure(`second-apply:${family}`, row?.stackId ?? 'missing', `expected unchanged got ${row?.status}`),
        );
      }
    }

    const missingId = planned.find((row) => row.family === 'rds')!.stackId;
    const missing = classifyStackRows(
      planned,
      resolveExistingState({
        existingStackNames: existingNames.filter((id) => id !== missingId),
        certStatus: 'issued',
        wouldChange: false,
      }),
      resolution,
      'staging',
    );
    expect(missing.rows.find((row) => row.stackId === missingId)?.status).toBe('create');
    expect(missing.rows.find((row) => row.family === 'website')?.status).toBe('unchanged');

    const withoutWeb = resolutionFor(
      resolution.components.filter((c) => c.component !== 'fixture-web'),
      resolution.resources.filter((r) => r.component !== 'fixture-web'),
    );
    const beforeAdd = listPlannedStacks(withoutWeb, 'staging');
    const afterAdd = listPlannedStacks(resolution, 'staging');
    const added = afterAdd.filter((row) => !beforeAdd.some((prev) => prev.stackId === row.stackId));
    expect(added.some((row) => row.family === 'website')).toBe(true);
    const sibling = afterAdd.find((row) => row.family === 'artifact');
    expect(beforeAdd.some((row) => row.stackId === sibling?.stackId)).toBe(true);
  });

  it('blocks Temporal without Postgres and omits that stack', () => {
    const resolution = resolutionFor([component('TemporalServer', 'fixture-temporal')]);
    const planned = listPlannedStacks(resolution, 'staging');
    const classified = classifyStackRows(planned, resolveExistingState({}), resolution, 'staging');
    const temporal = classified.rows.find((row) => row.family === 'temporal');
    expect(temporal?.status).toBe('blocked');
    expect(temporal?.reason).toMatch(/Postgres/);
    expect(classified.omitKeys.has('TemporalServer:fixture-temporal')).toBe(true);
    const printed = formatPlanSummaryLines(classified.rows).join('\n');
    expect(printed).toMatch(/blocked/);
    expect(printed).toMatch(/temporal-no-postgres/);
  });

  it('blocks HTTP ECS when cert is missing or pending', () => {
    const resolution = resolutionFor([
      component('ECSFargateService', 'fixture-api', {}, { runtimeType: 'ecs-fargate', routing: 'alb' }),
    ]);
    const planned = listPlannedStacks(resolution, 'staging');
    const missing = classifyStackRows(planned, resolveExistingState({ certStatus: 'missing' }), resolution, 'staging');
    expect(missing.rows.find((row) => row.family === 'ecs')?.status).toBe('blocked');
    const pending = classifyStackRows(planned, resolveExistingState({ certStatus: 'pending' }), resolution, 'staging');
    expect(pending.rows.find((row) => row.family === 'ecs')?.status).toBe('blocked');
    const issued = classifyStackRows(planned, resolveExistingState({ certStatus: 'issued' }), resolution, 'staging');
    expect(issued.rows.find((row) => row.family === 'ecs')?.status).toBe('create');
  });

  it('does not block beta HTTP without an issued cert', () => {
    const resolution = resolutionFor([
      component('ECSFargateService', 'fixture-api', {}, { runtimeType: 'ecs-fargate', routing: 'alb' }),
    ]);
    const planned = listPlannedStacks(resolution, 'beta');
    const classified = classifyStackRows(planned, resolveExistingState({ certStatus: 'missing' }), resolution, 'beta');
    expect(classified.rows.find((row) => row.family === 'ecs')?.status).toBe('create');
  });

  it('treats a declared certificateArn as issued unless certStatus is pending', () => {
    const resolution = resolutionFor([
      component(
        'ECSFargateService',
        'fixture-api',
        {},
        { runtimeType: 'ecs-fargate', routing: 'alb', certificateArn: certArn },
      ),
    ]);
    const planned = listPlannedStacks(resolution, 'staging');
    const declared = classifyStackRows(planned, resolveExistingState({ certStatus: 'missing' }), resolution, 'staging');
    expect(declared.rows.find((row) => row.family === 'ecs')?.status).toBe('create');
    const pending = classifyStackRows(planned, resolveExistingState({ certStatus: 'pending' }), resolution, 'staging');
    expect(pending.rows.find((row) => row.family === 'ecs')?.status).toBe('blocked');
  });

  it('creates first s+standard RDS and blocks replacement on an existing protected store', () => {
    const resolution = resolutionFor([
      component('RdsPostgresInstance', 'fixture-db', {
        engine: 'mysql',
        reliability: 'standard',
        appliedEngine: 'postgres',
      }),
    ]);
    const planned = listPlannedStacks(resolution, 'staging');
    const first = classifyStackRows(planned, resolveExistingState({}), resolution, 'staging');
    expect(first.rows.find((row) => row.family === 'rds')?.status).toBe('create');

    const rdsId = planned.find((row) => row.family === 'rds')!.stackId;
    const blocked = classifyStackRows(
      planned,
      resolveExistingState({ existingStackNames: [rdsId] }),
      resolution,
      'staging',
    );
    const row = blocked.rows.find((item) => item.family === 'rds');
    expect(row?.status).toBe('blocked');
    expect(row?.reason).toMatch(/engine/);
    expect(row?.rowId).toBe('protected-replacement');
  });

  it('imports an artifact bucket when HeadBucket is true', () => {
    const resolution = resolutionFor(
      [component('ArtifactDeploy', 'fixture-artifact')],
      [resource('s3ArtifactDeployment', 'fixture-artifact', 'p5-artifact-bucket')],
    );
    const planned = listPlannedStacks(resolution, 'staging');
    const classified = classifyStackRows(
      planned,
      resolveExistingState({ bucketExists: { 'p5-artifact-bucket': true } }),
      resolution,
      'staging',
    );
    expect(classified.rows.find((row) => row.family === 'artifact')?.status).toBe('import');
  });

  it('prints one status line per stack including Networking/Wiring', () => {
    const resolution = resolutionFor([
      component('RdsPostgresInstance', 'fixture-db', { engine: 'postgres' }),
    ]);
    const planned = listPlannedStacks(resolution, 'staging');
    expect(planned.some((row) => row.family === 'networking')).toBe(true);
    expect(planned.some((row) => row.family === 'wiring')).toBe(true);
    const lines = formatPlanSummaryLines(
      classifyStackRows(planned, resolveExistingState({}), resolution, 'staging').rows,
    );
    expect(lines.some((line) => line.includes('Networking'))).toBe(true);
    expect(lines.some((line) => line.includes('Wiring'))).toBe(true);
  });

  it('blocks collector without dba-fleet and omits that stack', () => {
    const resolution = resolutionFor([
      { ...component('ObserveIngest', 'fixture-observe', { strategyKey: 'infra.observe.metrics' }), strategy: 'metrics' },
    ]);
    const planned = listPlannedStacks(resolution, 'staging');
    const classified = classifyStackRows(planned, resolveExistingState({}), resolution, 'staging');
    const collector = classified.rows.find((row) => row.family === 'observe');
    const edge = classified.rows.find((row) => row.family === 'observe-to-ecs');
    const fleetEdge = classified.rows.find((row) => row.family === 'dba-fleet-to-observe');
    if (collector?.status !== 'blocked') {
      throw new Error(formatMatrixFailure('observe-no-dba-fleet', collector?.stackId ?? 'missing', `expected blocked got ${collector?.status}`));
    }
    expect(collector.reason).toMatch(/infra.compute.fleet.dba/);
    expect(classified.omitKeys.has('ObserveIngest:fixture-observe')).toBe(true);
    expect(edge?.status).toBe('blocked');
    expect(edge?.reason).toMatch(/infra.compute.fleet.dba/);
    expect(fleetEdge?.status).toBe('blocked');
    expect(fleetEdge?.reason).toMatch(/infra.compute.fleet.dba/);
  });

  it('blocks staging dashboard without dba-fleet, postgres, or issued cert', () => {
    const resolution = resolutionFor([
      { ...component('ObserveIngest', 'fixture-dashboard', { strategyKey: 'infra.observe.dashboard' }), strategy: 'dashboard' },
    ]);
    const planned = listPlannedStacks(resolution, 'staging');
    const noStore = classifyStackRows(planned, resolveExistingState({ certStatus: 'issued' }), resolution, 'staging');
    const dash = noStore.rows.find((row) => row.family === 'observe');
    expect(dash?.status).toBe('blocked');
    expect(dash?.reason).toMatch(/infra\.(compute\.fleet\.dba|db\.relational)/);
    const withFleetOnly = resolutionFor([
      component('DbaFleet', 'fixture-dba-fleet'),
      { ...component('ObserveIngest', 'fixture-dashboard', { strategyKey: 'infra.observe.dashboard' }), strategy: 'dashboard' },
    ]);
    const fleetOnly = classifyStackRows(
      listPlannedStacks(withFleetOnly, 'staging'),
      resolveExistingState({ certStatus: 'issued' }),
      withFleetOnly,
      'staging',
    );
    expect(fleetOnly.rows.find((row) => row.family === 'observe')?.status).toBe('blocked');
    expect(fleetOnly.rows.find((row) => row.family === 'observe')?.reason).toMatch(/infra.db.relational/);
    const withStores = resolutionFor([
      component('DbaFleet', 'fixture-dba-fleet'),
      component('RdsPostgresInstance', 'fixture-db'),
      { ...component('ObserveIngest', 'fixture-dashboard', { strategyKey: 'infra.observe.dashboard' }), strategy: 'dashboard' },
    ]);
    const pending = classifyStackRows(
      listPlannedStacks(withStores, 'staging'),
      resolveExistingState({ certStatus: 'pending' }),
      withStores,
      'staging',
    );
    expect(pending.rows.find((row) => row.family === 'observe')?.status).toBe('blocked');
  });

  it('blocks dashboard without postgres even on beta', () => {
    const resolution = resolutionFor([
      { ...component('ObserveIngest', 'fixture-dashboard', { strategyKey: 'infra.observe.dashboard' }), strategy: 'dashboard' },
    ]);
    const planned = listPlannedStacks(resolution, 'beta');
    const classified = classifyStackRows(planned, resolveExistingState({ certStatus: 'missing' }), resolution, 'beta');
    expect(classified.rows.find((row) => row.family === 'observe')?.status).toBe('blocked');
    expect(classified.rows.find((row) => row.family === 'observe')?.reason).toMatch(/infra.db.relational/);
    const withPg = resolutionFor([
      component('RdsPostgresInstance', 'fixture-db'),
      { ...component('ObserveIngest', 'fixture-dashboard', { strategyKey: 'infra.observe.dashboard' }), strategy: 'dashboard' },
    ]);
    const ok = classifyStackRows(
      listPlannedStacks(withPg, 'beta'),
      resolveExistingState({ certStatus: 'missing' }),
      withPg,
      'beta',
    );
    expect(ok.rows.find((row) => row.family === 'observe')?.status).toBe('create');
  });

  it('adds store then collector then dashboard without replacing siblings', () => {
    const store = resolutionFor([component('DbaFleet', 'fixture-dba-fleet')]);
    const storeCol = resolutionFor([
      component('DbaFleet', 'fixture-dba-fleet'),
      { ...component('ObserveIngest', 'fixture-observe', { strategyKey: 'infra.observe.metrics' }), strategy: 'metrics' },
    ]);
    const all = resolutionFor([
      component('DbaFleet', 'fixture-dba-fleet'),
      { ...component('ObserveIngest', 'fixture-observe', { strategyKey: 'infra.observe.metrics' }), strategy: 'metrics' },
      { ...component('ObserveIngest', 'fixture-dashboard', { strategyKey: 'infra.observe.dashboard' }), strategy: 'dashboard' },
    ]);
    const storeIds = listPlannedStacks(store, 'staging').map((row) => row.stackId);
    const colIds = listPlannedStacks(storeCol, 'staging').map((row) => row.stackId);
    const allIds = listPlannedStacks(all, 'staging').map((row) => row.stackId);
    const storeStack = storeIds.find((id) => id.includes('DbaFleet'));
    const colStack = colIds.find((id) => id.endsWith('fixture-observeObserve'));
    const edgeStack = colIds.find((id) => id.endsWith('fixture-observeObserveToEcs'));
    const fleetEdgeStack = colIds.find((id) => id.endsWith('fixture-observeDbaFleetToObserve'));
    const dashStack = allIds.find((id) => id.endsWith('fixture-dashboardObserve'));
    expect(storeStack).toBeDefined();
    expect(colIds).toContain(storeStack);
    expect(colStack).toBeDefined();
    expect(edgeStack).toBeDefined();
    expect(fleetEdgeStack).toBeDefined();
    expect(allIds).toContain(storeStack);
    expect(allIds).toContain(colStack);
    expect(allIds).toContain(edgeStack);
    expect(allIds).toContain(fleetEdgeStack);
    expect(dashStack).toBeDefined();
    expect(dashStack).not.toBe(colStack);
    expect(listPlannedStacks(all, 'staging').some((row) => row.family === 'observe-to-ecs' && row.construct === 'ObserveToEcs')).toBe(
      true,
    );
    expect(
      listPlannedStacks(all, 'staging').some(
        (row) => row.family === 'dba-fleet-to-observe' && row.construct === 'DbaFleetToObserve',
      ),
    ).toBe(true);
  });
});

describe('plan matrix family synth asserts', () => {
  it('keeps collector DesiredCount 1 on staging after resolvePortableExtras', () => {
    const extras = resolvePortableExtras({ env: 'staging', extras: {} });
    expect(extras['scaling.min']).toBe(2);
    const app = new App();
    const observeComponent = component('ObserveIngest', 'fixture-observe', extras);
    const profile = buildEnvProfile('staging', [observeComponent]);
    const networking = new NetworkingStack(app, 'NetObs', { env, profile, maxAzs: 2 });
    const shared = new EcsSharedStack(app, 'WireObs', {
      env,
      profile,
      networking,
      enableAlb: true,
      certificateArn: certArn,
    });
    const stack = new ObserveStack(app, 'Obs', {
      env,
      profile,
      component: observeComponent,
      networking,
      shared,
      emitCollector: true,
      emitDashboard: false,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: observeCollectorName('staging', 'fixture-observe'),
      DesiredCount: 1,
    });
  });

  it('keeps Redis 1-node on standard and DocDB BackupRetentionPeriod', () => {
    const extras = resolvePortableExtras({ env: 'staging', extras: {} });
    const redisApp = new App();
    const profile = buildEnvProfile('staging', []);
    const redisNet = new NetworkingStack(redisApp, 'NetRedis', { env, profile, maxAzs: 2 });
    const redis = new RedisStack(redisApp, 'RedisMtx', {
      env,
      profile,
      networking: redisNet,
      component: component('ElasticacheRedisCluster', 'fixture-cache', extras),
      extras,
    });
    Template.fromStack(redis).hasResourceProperties('AWS::ElastiCache::ReplicationGroup', { NumCacheClusters: 1 });

    const docApp = new App();
    const docNet = new NetworkingStack(docApp, 'NetDoc', { env, profile, maxAzs: 2 });
    const doc = new DocDbStack(docApp, 'DocMtx', {
      env,
      profile,
      networking: docNet,
      component: component('AwsDocumentDbCluster', 'fixture-doc', extras),
      extras,
    });
    Template.fromStack(doc).hasResourceProperties('AWS::DocDB::DBCluster', { BackupRetentionPeriod: 7 });
  });

  it('asserts artifact import write policy after ThonnasBucketExists', () => {
    const app = new App({ context: { 'ThonnasBucketExists:p5-artifact-bucket': 'true' } });
    const stack = new ArtifactStack(app, 'ArtImport', {
      env,
      profile: buildEnvProfile('staging', []),
      component: component('ArtifactDeploy', 'fixture-artifact'),
      projectRoot: '/tmp/plan-matrix-no-dist',
      resources: [resource('s3ArtifactDeployment', 'fixture-artifact', 'p5-artifact-bucket')],
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::S3::BucketPolicy', 1);
    expect(JSON.stringify(template.findResources('AWS::S3::BucketPolicy'))).toMatch(/s3:PutObject/);
  });
});



