import type { ReleaseContext } from './context';
import { releaseS3CloudFront, rollbackS3CloudFront, type StaticSiteReleasePort } from './s3-cloudfront';
import { releaseEcsFargate, rollbackEcsFargate } from './ecs-fargate';
import { releaseS3Artifact, rollbackS3Artifact } from './s3-artifact';
import { releaseLambdaAlias, rollbackLambdaAlias } from './lambda-alias';
import { releaseFleet, rollbackFleet } from './fleet';

// @intent Map strategy keys to release bindings; helpers mutate AWS only for implemented bindings

export type ReleaseBinding =
  | 's3-cloudfront'
  | 's3-artifact'
  | 'lambda-alias'
  | 'ecs-fargate'
  | 'nlb-tcp'
  | 'rds-postgres'
  | 'docdb'
  | 'elasticache-redis'
  | 'temporal'
  | 'fleet'
  | 'compose-host';

export type BindingKind = 'not-implemented' | 'noop' | 'unknown' | 'released';

export interface BindingResult {
  ok: boolean;
  kind: BindingKind;
  binding: string;
  message: string;
  from?: string | null;
  to?: string;
}

const STRATEGY_TO_BINDING: Record<string, ReleaseBinding> = {
  'infra.website.static': 's3-cloudfront',
  'infra.api.storage-temp-url': 'lambda-alias',
  'infra.artifact.deploy': 's3-artifact',
  'infra.container.managed-host': 'ecs-fargate',
  // @intent worker-manager-temporal (the only component implementing this strategy) has no
  // Dockerfile and runs the fixed public temporalio/auto-setup image unmodified -- there is
  // nothing for "release" to ever build/push, unlike api-go/dashboard-temporal's real app code
  // under 'infra.container.managed-host'. apply-only no-op, same category as rds-postgres/docdb.
  'infra.worker.temporal': 'temporal',
  'infra.db.relational': 'rds-postgres',
  'infra.db.document': 'docdb',
  'infra.cache.keyvalue': 'elasticache-redis',
  'infra.observe.metrics': 'ecs-fargate',
  'infra.observe.dashboard': 'ecs-fargate',
  'infra.compute.fleet.dba': 'fleet',
  'infra.compute.fleet.mqtt': 'fleet',
  // @intent compose-host has a real release/rollback (git reset + docker compose up), just not
  // through this artifact-rollout mechanism -- it runs as the release.compose-host deploy step
  // (release-beta.sh), scoped alongside infra.apply in the same job. Bare `thonnas release` with
  // no --target-component iterates every app package's own strategy, so every compose-host
  // component (the common case for a beta env with no artifact-based strategy at all) would
  // otherwise throw "no release binding" and abort the whole batch.
  'infra.container.compose-host': 'compose-host',
};

const NOOP_BINDINGS = new Set<ReleaseBinding>(['rds-postgres', 'docdb', 'elasticache-redis', 'compose-host', 'temporal']);

// @intent Keep nlb-tcp unimplemented; no strategy maps to it yet
const NOT_IMPLEMENTED = new Set<ReleaseBinding>(['nlb-tcp']);

export function bindingForStrategy(strategyKey: string): ReleaseBinding | undefined {
  return STRATEGY_TO_BINDING[strategyKey];
}

export function runReleaseBinding(binding: string): BindingResult {
  if (binding === 'compose-host') {
    return {
      ok: true,
      kind: 'noop',
      binding,
      from: null,
      to: 'noop',
      message:
        'compose-host is released by the release.compose-host deploy step (release-beta.sh), not this artifact-rollout mechanism; nothing to do here.',
    };
  }
  if (NOOP_BINDINGS.has(binding as ReleaseBinding)) {
    return {
      ok: true,
      kind: 'noop',
      binding,
      from: null,
      to: 'noop',
      message: `Binding ${binding} is apply-only; release and rollback are no-ops.`,
    };
  }
  if (binding === 's3-cloudfront') {
    return {
      ok: false,
      kind: 'not-implemented',
      binding,
      message:
        'Binding s3-cloudfront is implemented by executeRelease/executeRollback, not this sync table. Call those with packageDir and extras.',
    };
  }
  if (binding === 'ecs-fargate') {
    return {
      ok: false,
      kind: 'not-implemented',
      binding,
      message:
        'Binding ecs-fargate is implemented by executeRelease/executeRollback, not this sync table. Call those with packageDir and extras.',
    };
  }
  if (binding === 's3-artifact' || binding === 'lambda-alias' || binding === 'fleet') {
    return {
      ok: false,
      kind: 'not-implemented',
      binding,
      message: `Binding ${binding} is implemented by executeRelease/executeRollback, not this sync table. Call those with packageDir and extras.`,
    };
  }
  if (NOT_IMPLEMENTED.has(binding as ReleaseBinding)) {
    return {
      ok: false,
      kind: 'not-implemented',
      binding,
      message: `Binding ${binding} release helper is not implemented yet (Phase 6+).`,
    };
  }
  return {
    ok: false,
    kind: 'unknown',
    binding,
    message: `Unknown release binding "${binding}".`,
  };
}

export function runReleaseForStrategy(strategyKey: string | undefined): BindingResult {
  if (!strategyKey) {
    // @intent A package can legitimately declare thonnas-infra.json for endpoints/derivations
    // only (no "strategies" block) when it needs no env-specific AWS resource of its own -- e.g.
    // something purely compose-hosted with nothing for `infra apply` to provision. That's the
    // same "nothing for this mechanism to do" shape as an unmapped strategy like compose-host,
    // not a broken/unresolvable package; a bare (all-components) `thonnas release` must not abort
    // its whole batch just because one component's env block has no strategies.
    return {
      ok: true,
      kind: 'noop',
      binding: '',
      from: null,
      to: 'noop',
      message: 'No strategy declared for this package and env; nothing to release here.',
    };
  }
  const binding = bindingForStrategy(strategyKey);
  if (!binding) {
    return {
      ok: false,
      kind: 'unknown',
      binding: strategyKey,
      message: `No release binding for strategy "${strategyKey}".`,
    };
  }
  return runReleaseBinding(binding);
}

// @intent Dispatch mutating helpers including s3-artifact and lambda-alias
export async function executeRelease(
  ctx: ReleaseContext,
  port?: StaticSiteReleasePort,
): Promise<BindingResult> {
  if (!ctx.strategyKey) return runReleaseForStrategy(undefined);
  const binding = bindingForStrategy(ctx.strategyKey);
  if (!binding) return runReleaseForStrategy(ctx.strategyKey);
  if (binding === 's3-cloudfront') return releaseS3CloudFront(ctx, port);
  if (binding === 'ecs-fargate') return releaseEcsFargate(ctx);
  if (binding === 's3-artifact') return releaseS3Artifact(ctx);
  if (binding === 'lambda-alias') return releaseLambdaAlias(ctx);
  if (binding === 'fleet') return releaseFleet(ctx);
  return runReleaseBinding(binding);
}

// @intent Inverse of executeRelease for the same binding
export async function executeRollback(
  ctx: ReleaseContext,
  port?: StaticSiteReleasePort,
): Promise<BindingResult> {
  if (!ctx.strategyKey) return runReleaseForStrategy(undefined);
  const binding = bindingForStrategy(ctx.strategyKey);
  if (!binding) return runReleaseForStrategy(ctx.strategyKey);
  if (binding === 's3-cloudfront') return rollbackS3CloudFront(ctx, port);
  if (binding === 'ecs-fargate') return rollbackEcsFargate(ctx);
  if (binding === 's3-artifact') return rollbackS3Artifact(ctx);
  if (binding === 'lambda-alias') return rollbackLambdaAlias(ctx);
  if (binding === 'fleet') return rollbackFleet(ctx);
  return runReleaseBinding(binding);
}

// @intent Roll back succeeded mutating releases if a later package fails
export async function runRollbackableBatch(
  jobs: ReleaseContext[],
  exec: (ctx: ReleaseContext) => Promise<BindingResult>,
  rollback: (ctx: ReleaseContext) => Promise<BindingResult>,
): Promise<BindingResult[]> {
  const succeeded: ReleaseContext[] = [];
  const results: BindingResult[] = [];
  for (const ctx of jobs) {
    const result = await exec(ctx);
    if (!result.ok && jobs.length > 1 && result.kind === 'not-implemented') {
      results.push(result);
      continue;
    }
    if (!result.ok) {
      for (const done of [...succeeded].reverse()) {
        const undone = await rollback(done);
        if (!undone.ok) {
          throw new Error(
            `${result.message} (rollback also failed for ${done.component ?? done.packageDir}: ${undone.message})`,
          );
        }
      }
      throw new Error(result.message);
    }
    if (result.kind === 'released') {
      succeeded.push(ctx);
    }
    results.push(result);
  }
  return results;
}



