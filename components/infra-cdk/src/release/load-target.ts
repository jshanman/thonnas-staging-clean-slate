import fs from 'node:fs';
import path from 'node:path';
import type { ReleaseContext } from './context';
import { observeCollectorName, observeDashboardName } from '../stacks/observe-stack';

type StrategySlot = { key?: string; extras?: Record<string, unknown> };

// @intent Locate the target package dir and env extras from thonnas-infra.json

export function findPackageDir(
  projectRoot: string,
  flags: { targetComponent?: string; lib?: string; module?: string },
): string {
  // @intent Reject combined --target-component/--lib/--module filters
  const kinds = [flags.targetComponent, flags.lib, flags.module].filter(
    (value) => typeof value === 'string' && value.trim(),
  );
  if (kinds.length > 1) {
    throw new Error('thonnas release accepts only one of --target-component, --lib, or --module.');
  }
  if (flags.targetComponent) {
    const dir = path.join(projectRoot, 'components', flags.targetComponent);
    if (fs.existsSync(path.join(dir, 'thonnas-package.json'))) return dir;
    throw new Error(`Component "${flags.targetComponent}" not found under components/.`);
  }
  if (flags.lib) {
    const dir = path.join(projectRoot, '.thonnas', 'libs', flags.lib);
    if (fs.existsSync(path.join(dir, 'thonnas-package.json'))) return dir;
    throw new Error(`Lib "${flags.lib}" not found under .thonnas/libs/.`);
  }
  if (flags.module) {
    const componentsDir = path.join(projectRoot, 'components');
    if (fs.existsSync(componentsDir)) {
      for (const name of fs.readdirSync(componentsDir)) {
        const dir = path.join(componentsDir, name, 'modules', flags.module);
        if (fs.existsSync(path.join(dir, 'thonnas-package.json'))) return dir;
      }
    }
    throw new Error(`Module "${flags.module}" not found under components/*/modules/.`);
  }
  throw new Error('thonnas release requires exactly one of --target-component, --lib, or --module.');
}

function strategyMap(block: unknown): Record<string, StrategySlot> | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const strategies = (block as { strategies?: Record<string, StrategySlot> }).strategies;
  return strategies && typeof strategies === 'object' ? strategies : undefined;
}

// @intent Prefer website/static release over default simple-vm when both exist
function pickStrategyFromMap(strategies: Record<string, StrategySlot>): {
  strategyKey?: string;
  extras?: Record<string, unknown>;
} {
  const slots = Object.values(strategies).filter((slot): slot is StrategySlot => Boolean(slot));
  const byStatic = slots.find((slot) => slot.key === 'infra.website.static');
  const bySignedUrl = slots.find((slot) => slot.key === 'infra.api.storage-temp-url');
  const byArtifact = slots.find((slot) => slot.key === 'infra.artifact.deploy');
  const byRelational = slots.find((slot) => slot.key === 'infra.db.relational');
  const byDocument = slots.find((slot) => slot.key === 'infra.db.document');
  const byCache = slots.find((slot) => slot.key === 'infra.cache.keyvalue');
  const byRuntime = slots.find((slot) => slot.key === 'infra.container.managed-host');
  const byWorker = slots.find((slot) => slot.key === 'infra.worker.temporal');
  const byMetrics = slots.find((slot) => slot.key === 'infra.observe.metrics');
  const byDashboard = slots.find((slot) => slot.key === 'infra.observe.dashboard');
  const bySimpleVm = slots.find((slot) => slot.key === 'infra.container.simple-vm');
  // @intent infra.compute.fleet.* strategy slots are named inconsistently per component
  // (dba-clickhouse uses "store", queue-mqtt uses "broker") -- match by key prefix, not slot
  // name, so release actually selects the fleet strategy instead of silently falling through to
  // undefined (today's bug: both components' release step no-ops because nothing here recognizes
  // their slot name, never even reaching the fleet release binding).
  const byFleet = slots.find((slot) => typeof slot.key === 'string' && slot.key.startsWith('infra.compute.fleet.'));
  const chosen =
    byStatic ??
    bySignedUrl ??
    byArtifact ??
    byRelational ??
    byDocument ??
    byCache ??
    byRuntime ??
    byWorker ??
    byMetrics ??
    byDashboard ??
    byFleet ??
    strategies.website ??
    strategies.staticSite ??
    strategies.storageTempUrl ??
    strategies.artifactDeploy ??
    strategies.document ??
    strategies.cache ??
    strategies.database ??
    strategies.runtime ??
    strategies.worker ??
    strategies.metrics ??
    strategies.dashboard ??
    strategies.observe ??
    bySimpleVm;
  return {
    strategyKey: chosen?.key,
    extras: chosen?.extras,
  };
}

// @intent Merge default+env slots like the collector so staging website.static is not shadowed
function mergeStrategyMaps(
  defaultBlock: Record<string, unknown> | undefined,
  envBlock: Record<string, unknown> | undefined,
): Record<string, StrategySlot> {
  const base = strategyMap(defaultBlock) ?? {};
  const overlay = strategyMap(envBlock) ?? {};
  const keys = new Set([...Object.keys(base), ...Object.keys(overlay)]);
  const merged: Record<string, StrategySlot> = {};
  for (const key of keys) {
    const fromBase = base[key];
    const fromEnv = overlay[key];
    if (fromBase && fromEnv) {
      merged[key] = {
        key: fromEnv.key ?? fromBase.key,
        extras: { ...(fromBase.extras ?? {}), ...(fromEnv.extras ?? {}) },
      };
    } else {
      merged[key] = (fromEnv ?? fromBase) as StrategySlot;
    }
  }
  return merged;
}

// @intent Prefer website, signed-url, artifact, then data, host, temporal, observe
function pickStrategy(block: Record<string, unknown> | undefined): {
  strategyKey?: string;
  extras?: Record<string, unknown>;
} {
  const strategies = strategyMap(block);
  if (!strategies) return {};
  return pickStrategyFromMap(strategies);
}

export function loadReleaseExtras(
  packageDir: string,
  env: string,
): {
  strategyKey?: string;
  extras?: Record<string, unknown>;
} {
  const infraPath = path.join(packageDir, 'thonnas-infra.json');
  if (!fs.existsSync(infraPath)) return {};
  const doc = JSON.parse(fs.readFileSync(infraPath, 'utf8')) as Record<string, unknown>;
  const envKey = env === 'prod' ? 'production' : env;
  const envBlock = (doc[envKey] ?? (doc.environments as Record<string, unknown> | undefined)?.[envKey]) as
    | Record<string, unknown>
    | undefined;
  const defaultBlock = (doc.default ?? doc) as Record<string, unknown>;
  const merged = mergeStrategyMaps(defaultBlock, envBlock);
  if (Object.keys(merged).length > 0) {
    return pickStrategyFromMap(merged);
  }
  const fromEnv = pickStrategy(envBlock);
  const fromDefault = pickStrategy(defaultBlock);
  return {
    strategyKey: fromEnv.strategyKey ?? fromDefault.strategyKey,
    extras: { ...(fromDefault.extras ?? {}), ...(fromEnv.extras ?? {}) },
  };
}

// @intent Point ecs-fargate at the observe family name, not {env}-{component}
function observeServiceName(
  strategyKey: string | undefined,
  env: string,
  component: string | undefined,
): string | undefined {
  if (!component?.trim() || !strategyKey) return undefined;
  if (strategyKey === 'infra.observe.metrics') return observeCollectorName(env, component);
  if (strategyKey === 'infra.observe.dashboard') return observeDashboardName(env, component);
  return undefined;
}

export function buildReleaseContext(
  projectRoot: string,
  env: string,
  flags: { targetComponent?: string; lib?: string; module?: string; strategy?: string; imageTag?: string },
): ReleaseContext {
  const packageDir = findPackageDir(projectRoot, flags);
  const loaded = loadReleaseExtras(packageDir, env);
  const strategyKey = flags.strategy ?? loaded.strategyKey;
  const extras: Record<string, unknown> = { ...(loaded.extras ?? {}) };
  const rootDomain =
    (typeof extras.rootDomain === 'string' && extras.rootDomain.trim()) ||
    process.env.THONNAS_ROOT_DOMAIN?.trim() ||
    '';
  if (rootDomain) {
    extras.rootDomain = rootDomain;
    if (typeof extras.hosted_zone_domain === 'string' && extras.hosted_zone_domain.includes('{rootDomain}')) {
      extras.hosted_zone_domain = extras.hosted_zone_domain.replaceAll('{rootDomain}', rootDomain);
    }
  }
  // @intent Stack-naming project name must match plan/apply's resolution exactly (raw env var,
  // same THONNAS_PROJECT_NAME plan/apply's own handlers read in infra-provider.ts) -- fleetStackName
  // and ecs-fargate's release path both read ctx.extras.projectName to reconstruct the deterministic
  // stack name apply already created (e.g. "TmpStagingCleanSlateStaging...Fleet"); without this,
  // release silently falls back to no project-name prefix at all and can never find the real stack.
  const projectName =
    (typeof extras.projectName === 'string' && extras.projectName.trim()) ||
    process.env.THONNAS_PROJECT_NAME?.trim() ||
    '';
  if (projectName) {
    extras.projectName = projectName;
  }
  const service = observeServiceName(strategyKey, env, flags.targetComponent);
  if (service && extras.service == null) extras.service = service;
  return {
    projectRoot,
    env,
    packageDir,
    component: flags.targetComponent,
    lib: flags.lib,
    module: flags.module,
    strategyKey,
    imageTag: flags.imageTag,
    extras,
  };
}



