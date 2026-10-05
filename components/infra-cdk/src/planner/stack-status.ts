// @intent Classify plan rows before CDK synth; omit blocked stacks from the app

import { StrategyResolutionResult } from '../types';
import { buildEnvProfile } from '../cdk/env-profiles';
import { protectedReplacementReason, resolvePortableExtras } from '../release/portable-extras';
import { bucketIsImport, ExistingAwsState, stackExists } from './existing-state';

export type PlanStackStatus = 'create' | 'import' | 'update' | 'unchanged' | 'blocked';

export interface PlanStackRow {
  stackId: string;
  family: string;
  status: PlanStackStatus;
  reason?: string;
  rowId?: string;
  /** App components whose resources this stack synthesizes (shared stacks have none). */
  components?: string[];
}

export interface PlannedStackRef {
  stackId: string;
  family: string;
  component?: string;
  /** Every component folded into this stack id (e.g. all compose-host services). */
  components?: string[];
  construct?: string;
  omitKey?: string;
  needsIssuedCert?: boolean;
  isTemporal?: boolean;
  isDataPlane?: boolean;
  needsDbaFleet?: boolean;
  needsPostgres?: boolean;
  observeRole?: 'collector' | 'dashboard' | 'both';
  bucketName?: string;
}

const DATA_CONSTRUCTS = new Set([
  'RdsPostgresInstance',
  'AuroraPostgresCluster',
  'AwsDocumentDbCluster',
  'ElasticacheRedisCluster',
  'TemporalServer',
  'ObserveIngest',
  'DbaFleet',
  'MqttFleet',
]);

const needsNetworking = (resolution: StrategyResolutionResult): boolean =>
  resolution.components.some(
    (c) =>
      c.scope === 'service' &&
      (c.construct === 'ComposeHostEc2' ||
        c.metadata.runtimeType === 'ecs-fargate' ||
        c.metadata.runtimeType === 'ec2-docker' ||
        DATA_CONSTRUCTS.has(c.construct)),
  );

const omitKey = (construct: string, component: string): string => `${construct}:${component}`;

const resourceBucketName = (resolution: StrategyResolutionResult, component: string): string | undefined => {
  const resource = resolution.resources.find(
    (r) =>
      r.component === component &&
      (r.kind === 's3ArtifactDeployment' || r.kind === 's3WebsiteBucket') &&
      typeof r.props?.bucket === 'string',
  );
  return typeof resource?.props?.bucket === 'string' ? resource.props.bucket : undefined;
};

// @intent Mirror runtime stack ids so plan rows match CloudFormation names
export function listPlannedStacks(
  resolution: StrategyResolutionResult,
  env: string,
  projectName?: string,
  deploySlug?: string,
): PlannedStackRef[] {
  const profile = buildEnvProfile(env, resolution.components, deploySlug, projectName);
  const rows: PlannedStackRef[] = [];
  const seen = new Set<string>();
  const add = (ref: PlannedStackRef) => {
    // @intent Record every component folded into a shared stack id (one ComposeHost per env)
    if (seen.has(ref.stackId)) {
      const prior = rows.find((row) => row.stackId === ref.stackId);
      if (prior && ref.component && !prior.components?.includes(ref.component)) {
        prior.components = [...(prior.components ?? []), ref.component];
      }
      return;
    }
    seen.add(ref.stackId);
    rows.push(ref.component ? { ...ref, components: [ref.component] } : ref);
  };

  if (needsNetworking(resolution)) {
    add({ stackId: `${profile.networkingStackPrefix}Networking`, family: 'networking' });
    add({ stackId: `${profile.wiringStackPrefix}Wiring`, family: 'wiring' });
  }

  // @intent Mirror runtime.ts's GithubOidcStack synthesis (shared scope, env-wide, not per-component)
  if (resolution.resources.some((r) => r.kind === 'githubOidcIdentity')) {
    add({ stackId: `${profile.stackPrefix}GithubOidc`, family: 'github-oidc' });
  }

  for (const component of resolution.components) {
    if (component.scope !== 'service') continue;
    const prefix = profile.stackPrefix;
    const name = component.component;

    if (component.construct === 'ComposeHostEc2') {
      add({
        stackId: `${profile.composeHostStackPrefix}ComposeHost`,
        family: 'compose-host',
        component: name,
        construct: component.construct,
        omitKey: omitKey(component.construct, name),
      });
      continue;
    }

    if (component.construct === 'ECSFargateService' || component.metadata.runtimeType === 'ecs-fargate') {
      if (component.construct === 'TemporalServer' || component.construct === 'ObserveIngest') {
        // handled below
      } else {
        add({
          stackId: `${prefix}${name}Service`,
          family: 'ecs',
          component: name,
          construct: component.construct,
          omitKey: omitKey(component.construct, name),
          needsIssuedCert: profile.category === 'staging' || profile.category === 'prod',
        });
      }
    }

    if (component.construct === 'RdsPostgresInstance') {
      add({
        stackId: `${prefix}${name}Rds`,
        family: 'rds',
        component: name,
        construct: component.construct,
        omitKey: omitKey(component.construct, name),
        isDataPlane: true,
      });
      // @intent Distinct plan row for Relational→ECS secret injection edge
      add({
        stackId: `${prefix}${name}RelationalToEcs`,
        family: 'relational-to-ecs',
        component: name,
        construct: 'RelationalToEcs',
      });
    }
    if (component.construct === 'AwsDocumentDbCluster') {
      add({
        stackId: `${prefix}${name}DocDb`,
        family: 'docdb',
        component: name,
        construct: component.construct,
        omitKey: omitKey(component.construct, name),
        isDataPlane: true,
      });
      // @intent Distinct plan row for Document→ECS secret injection edge
      add({
        stackId: `${prefix}${name}DocumentToEcs`,
        family: 'document-to-ecs',
        component: name,
        construct: 'DocumentToEcs',
      });
    }
    if (component.construct === 'ElasticacheRedisCluster') {
      add({
        stackId: `${prefix}${name}Redis`,
        family: 'redis',
        component: name,
        construct: component.construct,
        omitKey: omitKey(component.construct, name),
        isDataPlane: true,
      });
      add({
        stackId: `${prefix}${name}CacheToEcs`,
        family: 'cache-to-ecs',
        component: name,
        construct: 'CacheToEcs',
      });
    }
    if (component.construct === 'TemporalServer') {
      add({
        stackId: `${prefix}${name}Temporal`,
        family: 'temporal',
        component: name,
        construct: component.construct,
        omitKey: omitKey(component.construct, name),
        isTemporal: true,
      });
      // @intent Distinct plan row for the Temporal->ECS edge (mirrors cache-to-ecs above) -- without
      // this row the planner's own stack list never includes TemporalToEcsStack for --target-component,
      // the same "silently dropped from deploy" bug already fixed for EdgeNlb/EventsBus/Networking/Wiring.
      add({
        stackId: `${prefix}${name}TemporalToEcs`,
        family: 'temporal-to-ecs',
        component: name,
        construct: 'TemporalToEcs',
        isTemporal: true,
      });
    }
    if (component.construct === 'DbaFleet') {
      add({
        stackId: `${prefix}${name}DbaFleet`,
        family: 'dba-fleet',
        component: name,
        construct: component.construct,
        omitKey: omitKey(component.construct, name),
        isDataPlane: true,
      });
    }
    if (component.construct === 'MqttFleet') {
      add({
        stackId: `${prefix}${name}MqttFleet`,
        family: 'mqtt-fleet',
        component: name,
        construct: component.construct,
        omitKey: omitKey(component.construct, name),
        isDataPlane: true,
      });
      // @intent Distinct plan row for the MqttFleet→ECS credential-injection edge (mirrors
      // cache-to-ecs above) -- without this row the planner's own stack list never includes
      // MqttFleetToEcsStack, so `cdk deploy` (invoked with that explicit list) silently skips it
      // even though runtime.ts's createCdkApp genuinely constructs it. Confirmed live: the stack
      // was absent from the printed "Running aws-cdk deploy for env..." list despite the compiled
      // runtime.js unconditionally creating it whenever a fleet + Fargate peers both exist.
      add({
        stackId: `${prefix}${name}MqttFleetToEcs`,
        family: 'mqtt-fleet-to-ecs',
        component: name,
        construct: 'MqttFleetToEcs',
      });
    }
    if (component.construct === 'ObserveIngest') {
      const role = observeRoleFor(component);
      const stagingOrProd = profile.category === 'staging' || profile.category === 'prod';
      const needsDashboardPg = role === 'dashboard' || role === 'both';
      add({
        stackId: `${prefix}${name}Observe`,
        family: 'observe',
        component: name,
        construct: component.construct,
        omitKey: omitKey(component.construct, name),
        observeRole: role,
        needsDbaFleet: role === 'collector' || role === 'both' || stagingOrProd,
        needsPostgres: needsDashboardPg,
        needsIssuedCert: stagingOrProd && role !== 'collector',
      });
      // @intent Distinct plan row for the Observe→ECS edge (not nested under observe)
      if (role === 'collector' || role === 'both') {
        add({
          stackId: `${prefix}${name}ObserveToEcs`,
          family: 'observe-to-ecs',
          component: name,
          construct: 'ObserveToEcs',
          observeRole: role,
          needsDbaFleet: true,
        });
        // @intent Distinct plan row for the DbaFleet→Observe peer edge
        add({
          stackId: `${prefix}${name}DbaFleetToObserve`,
          family: 'dba-fleet-to-observe',
          component: name,
          construct: 'DbaFleetToObserve',
          observeRole: role,
          needsDbaFleet: true,
        });
      }
      // @intent Distinct plan row for Relational→Observe (dashboard metastore)
      if (needsDashboardPg) {
        add({
          stackId: `${prefix}${name}RelationalToObserve`,
          family: 'relational-to-observe',
          component: name,
          construct: 'RelationalToObserve',
          observeRole: role,
          needsPostgres: true,
        });
      }
    }
    if (component.construct === 'StorageTempUrlApi') {
      add({
        stackId: `${prefix}${name}SignedUrl`,
        family: 'signed-url',
        component: name,
        construct: component.construct,
        omitKey: omitKey(component.construct, name),
      });
    }
  }

  const staticSiteNames = new Set(
    resolution.resources.filter((r) => r.kind === 's3StaticSiteDeployment' && r.component).map((r) => r.component as string),
  );
  const artifactNames = new Set<string>();
  for (const c of resolution.components) {
    if (c.construct === 'ArtifactDeploy') artifactNames.add(c.component);
    if (c.construct === 'S3WebsiteBucket' && !staticSiteNames.has(c.component)) artifactNames.add(c.component);
  }
  for (const r of resolution.resources) {
    if (r.kind === 's3ArtifactDeployment' && r.component) artifactNames.add(r.component);
    if (r.kind === 's3WebsiteBucket' && r.component && !staticSiteNames.has(r.component)) artifactNames.add(r.component);
  }
  for (const name of artifactNames) {
    add({
      stackId: `${profile.stackPrefix}${name}Artifact`,
      family: 'artifact',
      component: name,
      construct: 'ArtifactDeploy',
      omitKey: omitKey('ArtifactDeploy', name),
      bucketName: resourceBucketName(resolution, name),
    });
  }
  for (const name of staticSiteNames) {
    add({
      stackId: `${profile.stackPrefix}${name}StaticSite`,
      family: 'website',
      component: name,
      construct: 'StaticSite',
      omitKey: omitKey('StaticSite', name),
    });
  }

  const nlbOwners = resolution.components.filter((c) =>
    (c.metadata.protocols ?? []).some((p) => p === 'mqtt' || p === 'ws' || p === 'tcp'),
  );
  if (nlbOwners.length && needsNetworking(resolution)) {
    for (const owner of nlbOwners) {
      add({ stackId: `${profile.stackPrefix}EdgeNlb`, family: 'nlb', component: owner.component });
    }
  }

  const eventBusResources = resolution.resources.filter((resource) => resource.kind === 'snsSqsEventBus');
  if (eventBusResources.length) {
    const owners = eventBusResources.filter((r) => r.component);
    if (owners.length) {
      for (const owner of owners) {
        add({ stackId: `${profile.stackPrefix}EventsBus`, family: 'events-bus', component: owner.component });
      }
    } else {
      add({ stackId: `${profile.stackPrefix}EventsBus`, family: 'events-bus' });
    }
  }

  return rows;
}

export interface ClassifyResult {
  rows: PlanStackRow[];
  omitKeys: Set<string>;
}

const hasPostgres = (resolution: StrategyResolutionResult): boolean =>
  resolution.components.some((c) => c.construct === 'RdsPostgresInstance');

const hasDbaFleet = (resolution: StrategyResolutionResult): boolean =>
  resolution.components.some((c) => c.construct === 'DbaFleet');

// @intent Distinguish collector vs dashboard without renaming the observe family
export function observeRoleFor(
  component: StrategyResolutionResult['components'][number],
): 'collector' | 'dashboard' | 'both' {
  const slot = (component.strategy ?? '').toLowerCase();
  const extras = component.metadata.extras as Record<string, unknown> | undefined;
  const key = typeof extras?.strategyKey === 'string' ? extras.strategyKey : '';
  if (key === 'infra.observe.metrics' || slot === 'metrics' || slot === 'collector') return 'collector';
  if (key === 'infra.observe.dashboard' || slot === 'dashboard') return 'dashboard';
  return 'both';
}

const extrasFor = (resolution: StrategyResolutionResult, component?: string): Record<string, unknown> | undefined => {
  if (!component) return undefined;
  return resolution.components.find((c) => c.component === component)?.metadata.extras;
};

// @intent Upgrade missing cert to issued when a component already declares an ARN
const effectiveCertStatus = (
  existing: ExistingAwsState,
  resolution: StrategyResolutionResult,
): ExistingAwsState['certStatus'] => {
  if (existing.certStatus !== 'missing') return existing.certStatus;
  const declared = resolution.components.some((c) => {
    const extras = c.metadata.extras as Record<string, unknown> | undefined;
    const metaArn = typeof c.metadata.certificateArn === 'string' ? c.metadata.certificateArn.trim() : '';
    const extraArn = typeof extras?.certificateArn === 'string' ? extras.certificateArn.trim() : '';
    return Boolean(metaArn || extraArn);
  });
  return declared ? 'issued' : existing.certStatus;
};

// @intent Emit create|import|update|unchanged|blocked from injected/real existing state
export function classifyStackRows(
  planned: PlannedStackRef[],
  existing: ExistingAwsState,
  resolution: StrategyResolutionResult,
  env: string,
): ClassifyResult {
  const omitKeys = new Set<string>();
  const postgresPresent = hasPostgres(resolution);
  const dbaFleetPresent = hasDbaFleet(resolution);
  const certStatus = effectiveCertStatus(existing, resolution);
  const classifyStackRow = (ref: PlannedStackRef): PlanStackRow => {
    const rowId = `family:${ref.family}`;
    const extras = extrasFor(resolution, ref.component);

    if (ref.needsDbaFleet && !dbaFleetPresent) {
      if (ref.omitKey) omitKeys.add(ref.omitKey);
      const who = ref.observeRole === 'dashboard' ? 'dashboard' : 'collector';
      return {
        stackId: ref.stackId,
        family: ref.family,
        status: 'blocked',
        reason: `blocked: ${who} requires infra.compute.fleet.dba`,
        rowId: 'observe-no-dba-fleet',
      };
    }

    if (ref.isTemporal && !postgresPresent) {
      if (ref.omitKey) omitKeys.add(ref.omitKey);
      return {
        stackId: ref.stackId,
        family: ref.family,
        status: 'blocked',
        reason: 'blocked: temporal requires infra.db.relational (Postgres)',
        rowId: 'temporal-no-postgres',
      };
    }

    if (ref.needsPostgres && !postgresPresent) {
      if (ref.omitKey) omitKeys.add(ref.omitKey);
      return {
        stackId: ref.stackId,
        family: ref.family,
        status: 'blocked',
        reason: 'blocked: dashboard requires infra.db.relational (Postgres metastore)',
        rowId: 'observe-no-postgres',
      };
    }

    if (ref.needsIssuedCert && certStatus !== 'issued') {
      if (ref.omitKey) omitKeys.add(ref.omitKey);
      return {
        stackId: ref.stackId,
        family: ref.family,
        status: 'blocked',
        reason: `blocked: HTTP ECS requires an ISSUED listener/cert (certStatus=${certStatus})`,
        rowId: 'http-no-listener-cert',
      };
    }

    if (ref.isDataPlane) {
      const resolved = resolvePortableExtras({ env, extras });
      const reason = protectedReplacementReason({
        extras: resolved,
        env,
        existing: stackExists(existing, ref.stackId),
        appliedEngine:
          typeof extras?.appliedEngine === 'string'
            ? extras.appliedEngine
            : typeof resolved.appliedEngine === 'string'
              ? resolved.appliedEngine
              : undefined,
        appliedInstanceClass:
          typeof extras?.appliedInstanceClass === 'string'
            ? extras.appliedInstanceClass
            : typeof resolved.appliedInstanceClass === 'string'
              ? resolved.appliedInstanceClass
              : undefined,
      });
      if (reason) {
        if (ref.omitKey) omitKeys.add(ref.omitKey);
        return {
          stackId: ref.stackId,
          family: ref.family,
          status: 'blocked',
          reason,
          rowId: 'protected-replacement',
        };
      }
    }

    if (bucketIsImport(existing, ref.bucketName)) {
      return { stackId: ref.stackId, family: ref.family, status: 'import', rowId: 'artifact-import' };
    }

    if (!stackExists(existing, ref.stackId)) {
      return { stackId: ref.stackId, family: ref.family, status: 'create', rowId };
    }

    const change = existing.wouldChange(ref.stackId);
    if (change === true) {
      return { stackId: ref.stackId, family: ref.family, status: 'update', rowId: 'second-apply-update' };
    }
    if (change === false) {
      return { stackId: ref.stackId, family: ref.family, status: 'unchanged', rowId: 'second-apply' };
    }
    return { stackId: ref.stackId, family: ref.family, status: 'update', rowId: 'exists-unknown-change' };
  };
  const rows: PlanStackRow[] = planned.map((ref) => {
    const row = classifyStackRow(ref);
    return ref.components?.length ? { ...row, components: ref.components } : row;
  });

  return { rows, omitKeys };
}

// @intent Drop blocked constructs so CDK synth does not throw
export function omitBlockedFromResolution(
  resolution: StrategyResolutionResult,
  omitKeys: Set<string>,
): StrategyResolutionResult {
  if (omitKeys.size === 0) return resolution;
  return {
    ...resolution,
    components: resolution.components.filter((c) => !omitKeys.has(omitKey(c.construct, c.component))),
  };
}

// @intent Print one status line per stack for tests and the provider
export function formatPlanSummaryLines(rows: PlanStackRow[]): string[] {
  return rows.map((row) => {
    const base = `${row.status}  ${row.stackId}  family=${row.family}`;
    if (row.status === 'blocked') {
      return `${base}  reason=${row.reason ?? 'blocked'}  row=${row.rowId ?? 'unknown'}  stack=${row.stackId}`;
    }
    return row.rowId ? `${base}  row=${row.rowId}` : base;
  });
}

export function formatMatrixFailure(rowId: string, stackId: string, message: string): string {
  return `matrix row=${rowId} stack=${stackId}: ${message}`;
}

export function deployableStackIds(rows: PlanStackRow[]): string[] {
  return rows.filter((row) => row.status !== 'blocked').map((row) => row.stackId);
}

export function allTargetedBlocked(rows: PlanStackRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.status === 'blocked');
}

// @intent Stacks with no owning component (VPC/subnets, cross-stack wiring, org-wide OIDC) that
// every component implicitly depends on. `deploy` must always include these regardless of
// --target-component scope: `row.components` can never contain a requested target for them, so
// without this they were silently dropped from the actual deploy list -- confirmed live, where
// a --target-component apply that reached CDK's cross-stack-reference migration failed because
// Networking/Wiring kept serving stale-format outputs (dependencies are always *synthesized*, per
// the target-closure mechanism, but that is not the same as being *deployed*). `cdk deploy` is a
// no-op for these when their template is unchanged, so including them is cheap; excluding them is
// what caused the staleness. Never add these for `destroy` -- that would tear down the VPC/wiring
// out from under every other targeted stack.
const ALWAYS_DEPLOY_FAMILIES = new Set(['networking', 'wiring', 'github-oidc']);

// @intent Resolve --target-component to its own stack ids; fail closed when it synthesizes none
export function selectTargetStackIds(rows: PlanStackRow[], targets: string[], verb: 'deploy' | 'destroy'): string[] {
  const owned = rows.filter((row) => row.components?.some((c) => targets.includes(c)));
  const stackIds = deployableStackIds(owned);
  const missing = targets.filter(
    (target) => !owned.some((row) => row.status !== 'blocked' && row.components?.includes(target)),
  );
  if (missing.length) {
    const blocked = owned
      .filter((row) => row.status === 'blocked')
      .map((row) => `${row.stackId} (${row.reason ?? 'blocked'})`);
    throw new Error(
      `--target-component ${missing.join(',')} produced no ${verb}able stacks` +
        (blocked.length ? `; blocked: ${blocked.join('; ')}` : '') +
        `; refusing to run cdk ${verb}`,
    );
  }
  if (verb === 'deploy') {
    const foundationalIds = rows
      .filter((row) => ALWAYS_DEPLOY_FAMILIES.has(row.family) && row.status !== 'blocked')
      .map((row) => row.stackId)
      .filter((id) => !stackIds.includes(id));
    return [...foundationalIds, ...stackIds];
  }
  return stackIds;
}

