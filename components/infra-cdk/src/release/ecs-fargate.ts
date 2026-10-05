import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  waitUntilServicesStable,
} from '@aws-sdk/client-ecs';
import {
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BindingResult } from './bindings';
import type { ReleaseContext } from './context';
import { buildEnvProfile } from '../cdk/env-profiles';
import { extraNumber, httpTargetGroupName } from '../stacks/ecs-service-stack';
import { observeDashboardTargetGroupName } from '../stacks/observe-stack';
import { ecrImageUri, ecrRepositoryName } from '../utils/path-helpers';
import { resolvePortableExtras, shouldMergeResolvedHostEnv, stableWaitSeconds } from './portable-extras';

// @intent Parse component .env.{env} for managed-host task env (config resolve / host vars)
export async function loadResolvedHostEnv(
  packageDir: string | undefined,
  env: string,
): Promise<Record<string, string>> {
  if (!packageDir?.trim()) return {};
  const envPath = path.join(packageDir, `.env.${env}`);
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  const raw = await fs.readFile(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // Keep SECRET__* — Nest maps database.username/password from those exact names.
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Skip blank overlays so empty PORT=/NODE_ENV= do not clobber image defaults.
    if (value === '') continue;
    out[key] = value;
  }
  return out;
}

export type MergeHostEnvOptions = {
  /** Keep apply-time env and SM secret names; only fill missing keys. */
  preserveExisting?: boolean;
};

// @intent Overlay resolved host env onto a container definition's environment list
export function mergeHostEnvIntoContainer<
  T extends {
    environment?: { name?: string; value?: string }[];
    secrets?: { name?: string }[];
  },
>(container: T, hostEnv: Record<string, string>, options?: MergeHostEnvOptions): T {
  const keys = Object.keys(hostEnv);
  if (keys.length === 0) return container;
  const byName = new Map<string, string>();
  for (const entry of container.environment ?? []) {
    if (entry.name) byName.set(entry.name, entry.value ?? '');
  }
  const existingSecrets = new Set(
    (container.secrets ?? []).map((entry) => entry.name).filter((name): name is string => Boolean(name)),
  );
  for (const [name, value] of Object.entries(hostEnv)) {
    if (options?.preserveExisting && (byName.has(name) || existingSecrets.has(name))) continue;
    byName.set(name, value);
  }
  return {
    ...container,
    environment: Array.from(byName.entries()).map(([name, value]) => ({ name, value })),
  };
}

type SecretsManifestExport = { name?: string; cloneTo?: string[] };

// @intent Names from thonnas-secrets.json exports + cloneTo (no component names)
export async function readSecretExportNames(packageDir: string | undefined): Promise<string[]> {
  if (!packageDir?.trim()) return [];
  const manifestPath = path.join(packageDir, 'thonnas-secrets.json');
  if (!existsSync(manifestPath)) return [];
  let parsed: { exports?: SecretsManifestExport[] };
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { exports?: SecretsManifestExport[] };
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const exp of parsed.exports ?? []) {
    const name = typeof exp.name === 'string' ? exp.name.trim() : '';
    if (!name) continue;
    names.add(name);
    names.add(`SECRET__${name}`);
    for (const clone of exp.cloneTo ?? []) {
      if (typeof clone === 'string' && clone.trim()) names.add(clone.trim());
    }
  }
  return [...names];
}

// @intent release.env=apply: fill app secrets from resolve without compose hosts / LocalStack
export async function loadResolvedAppSecretEnv(
  packageDir: string | undefined,
  env: string,
): Promise<Record<string, string>> {
  const allowed = new Set(await readSecretExportNames(packageDir));
  if (allowed.size === 0) return {};
  const host = await loadResolvedHostEnv(packageDir, env);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}


// @intent Derive Wiring cluster name from env profile, not {env}-cluster
export function wiringClusterName(env: string, projectName?: string): string {
  const fromEnv =
    (typeof projectName === 'string' && projectName.trim()) || process.env.THONNAS_PROJECT_NAME?.trim();
  const profile = buildEnvProfile(env, [], undefined, fromEnv);
  return `${profile.wiringStackPrefix}Wiring-cluster`;
}

// @intent Resolve ECS cluster/service ids; default cluster is Wiring-shaped, not env-cluster
export function resolveEcsReleaseIds(ctx: ReleaseContext): {
  cluster: string;
  service: string;
  imageTag: string;
} {
  const extrasProject =
    typeof ctx.extras?.projectName === 'string' && ctx.extras.projectName.trim()
      ? ctx.extras.projectName.trim()
      : undefined;
  const cluster =
    (typeof ctx.extras?.cluster === 'string' && ctx.extras.cluster.trim()) ||
    wiringClusterName(ctx.env, extrasProject);
  const service =
    (typeof ctx.extras?.service === 'string' && ctx.extras.service.trim()) ||
    (ctx.component ? `${ctx.env}-${ctx.component}` : '');
  const imageTag = ctx.imageTag || 'latest';
  return { cluster, service, imageTag };
}

// @intent Detect pause so release never attaches it to the edge
export function isPauseContainerImage(image?: string): boolean {
  if (!image) return false;
  return /\/pause(?::|@|$)/i.test(image) || image.includes('kubernetes/pause');
}

// @intent Add shell health only when the image is known to have a shell
export function withReleaseContainerHealth<
  T extends { image?: string; healthCheck?: { command?: string[] } },
>(container: T): T {
  if (isPauseContainerImage(container.image)) return container;
  // @intent Skip apply health on known collector images (package may leave none)
  if (/opentelemetry-collector/i.test(container.image || '')) {
    const rest = { ...container };
    delete rest.healthCheck;
    return rest;
  }
  if (container.healthCheck?.command?.length) return container;
  return {
    ...container,
    healthCheck: {
      command: ['CMD-SHELL', 'exit 0'],
      interval: 30,
      timeout: 5,
      retries: 3,
      startPeriod: 60,
    },
  };
}

// @intent Require an immutable tag for HTTP and observe releases
export function isPinnedImageTag(tag?: string): boolean {
  const trimmed = tag?.trim();
  return Boolean(trimmed) && trimmed !== 'latest';
}

export type ResolveReleaseImageEcr = {
  env: string;
  component: string;
  accountId: string;
  region: string;
  /** Same project key as apply/plan so pause→ECR URI matches created repo */
  projectName?: string;
};

// @intent Accept full URI; on pause+bare tag resolve apply's ECR repo; else swap tag
export function resolveReleaseImage(
  currentImage: string | undefined,
  imageTag: string,
  ecr?: ResolveReleaseImageEcr,
): { image: string } | { error: string } {
  const pinned = imageTag.trim();
  if (pinned.includes('/')) return { image: pinned };
  const current = currentImage?.trim() || '';
  if (isPauseContainerImage(current) || !current) {
    if (!ecr?.env?.trim() || !ecr.component?.trim() || !ecr.accountId?.trim() || !ecr.region?.trim()) {
      return {
        error:
          'ecs-fargate release cannot leave the pause image: pass a full image URI in --image-tag, or ensure env, --target-component, AWS account, and region resolve so the ECR repository from apply can be used.',
      };
    }
    const repoName = ecrRepositoryName(ecr.env, ecr.component, ecr.projectName);
    if (!repoName) {
      return {
        error: `ecs-fargate release could not derive ECR repository name for env=${ecr.env} component=${ecr.component}.`,
      };
    }
    return { image: ecrImageUri(ecr.accountId.trim(), ecr.region.trim(), repoName, pinned) };
  }
  const colon = current.lastIndexOf(':');
  const digest = current.lastIndexOf('@');
  if (digest > 0 && (colon < 0 || digest > colon)) {
    return { image: `${current.slice(0, digest)}:${pinned}` };
  }
  if (colon > 0 && !current.slice(colon + 1).includes('/')) {
    return { image: `${current.slice(0, colon)}:${pinned}` };
  }
  return { image: `${current}:${pinned}` };
}

// @intent Prefer env account ids; fall back to STS for pause→ECR release
export async function resolveReleaseAccountId(region: string): Promise<string | undefined> {
  const fromEnv =
    process.env.CDK_DEFAULT_ACCOUNT?.trim() ||
    process.env.AWS_ACCOUNT_ID?.trim() ||
    process.env.THONNAS_AWS_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const sts = new STSClient({ region });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return identity.Account?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// @intent Look up the CDK TG name (32-char slice), not the unsliced family
export function releaseTargetGroupName(ctx: ReleaseContext, service: string): string {
  if (isDashboardRelease(ctx, service)) {
    const component = ctx.component?.trim() || dashboardComponentFromService(ctx.env, service);
    return observeDashboardTargetGroupName(ctx.env, component, process.env.THONNAS_PROJECT_NAME);
  }
  const component = ctx.component?.trim() || service.replace(new RegExp(`^${ctx.env}-`), '');
  return httpTargetGroupName(ctx.env, component, process.env.THONNAS_PROJECT_NAME);
}

export async function releaseEcsFargate(ctx: ReleaseContext): Promise<BindingResult> {
  if (!isPinnedImageTag(ctx.imageTag)) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: 'ecs-fargate release requires a pinned --image-tag (not omitted, not latest).',
    };
  }
  const { cluster, service, imageTag } = resolveEcsReleaseIds(ctx);
  if (!service) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: 'ecs-fargate release requires --target-component or extras.service.',
    };
  }
  const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
  const ecs = new ECSClient({ region });
  const described = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
  const current = described.services?.[0];
  if (!current?.taskDefinition) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: `ECS service ${service} not found in cluster ${cluster}. Apply first.`,
    };
  }
  const fromArn = current.taskDefinition;
  const task = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: fromArn }));
  const def = task.taskDefinition;
  if (!def?.containerDefinitions?.[0]) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: `Task definition missing for ${service}.`,
    };
  }
  const mergeResolvedHosts =
    ctx.strategyKey === 'infra.container.managed-host' && shouldMergeResolvedHostEnv(ctx.extras);
  const hostEnv = !mergeResolvedHosts
    ? ctx.strategyKey === 'infra.container.managed-host'
      ? await loadResolvedAppSecretEnv(ctx.packageDir, ctx.env)
      : {}
    : await loadResolvedHostEnv(ctx.packageDir, ctx.env);
  const needsEcr =
    !imageTag.includes('/') &&
    def.containerDefinitions.some((c) => isPauseContainerImage(c.image) || !c.image?.trim());
  let ecr: ResolveReleaseImageEcr | undefined;
  if (needsEcr) {
    const component = ctx.component?.trim();
    const accountId = await resolveReleaseAccountId(region);
    if (!component || !accountId) {
      return {
        ok: false,
        kind: 'unknown',
        binding: 'ecs-fargate',
        message:
          'ecs-fargate release cannot leave the pause image: pass a full image URI in --image-tag, or ensure --target-component and AWS account (CDK_DEFAULT_ACCOUNT / STS) resolve so the ECR repository from apply can be used.',
      };
    }
    ecr = {
      env: ctx.env,
      component,
      accountId,
      region,
      projectName:
        (typeof ctx.extras?.projectName === 'string' && ctx.extras.projectName.trim()) ||
        process.env.THONNAS_PROJECT_NAME?.trim() ||
        undefined,
    };
  }
  const containers: Array<{
    name?: string;
    image?: string;
    portMappings?: Array<{ containerPort?: number }>;
    [key: string]: unknown;
  }> = [];
  for (const c of def.containerDefinitions) {
    const resolved = resolveReleaseImage(c.image, imageTag, ecr);
    if ('error' in resolved) {
      return {
        ok: false,
        kind: 'unknown',
        binding: 'ecs-fargate',
        message: resolved.error,
      };
    }
    // @intent Keep apply-time environment/secrets (fleet host + SM password) across release
    const next = {
      ...c,
      image: resolved.image,
      environment: c.environment,
      secrets: c.secrets,
    };
    // @intent Collector release swaps image only; product boot lives in fixture hooks
    if (isCollectorRelease(ctx, service)) {
      const rest = { ...next };
      delete rest.healthCheck;
      containers.push(rest);
      continue;
    }
    // @intent Dashboard release swaps image, drops mounts, keeps portable env/secrets
    if (isDashboardRelease(ctx, service)) {
      const rest = { ...next };
      delete rest.mountPoints;
      containers.push(withReleaseContainerHealth(rest));
      continue;
    }
    // @intent Managed-host: resolve overlays hosts; apply keeps RelationalToEcs/DocumentToEcs and fills secrets
    if (ctx.strategyKey === 'infra.container.managed-host') {
      containers.push(
        withReleaseContainerHealth(
          mergeHostEnvIntoContainer(next, hostEnv, { preserveExisting: !mergeResolvedHosts }),
        ),
      );
      continue;
    }
    containers.push(withReleaseContainerHealth(next));
  }
  const registered = await ecs.send(
    new RegisterTaskDefinitionCommand({
      family: def.family,
      taskRoleArn: def.taskRoleArn,
      executionRoleArn: def.executionRoleArn,
      networkMode: def.networkMode,
      containerDefinitions: containers,
      requiresCompatibilities: def.requiresCompatibilities,
      cpu: def.cpu,
      memory: def.memory,
      runtimePlatform: def.runtimePlatform,
    }),
  );
  const toArn = registered.taskDefinition?.taskDefinitionArn;
  if (!toArn) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: `Failed to register a new task definition for ${service}.`,
    };
  }
  const loadBalancers = await resolveHttpAttach(ctx, service, current.loadBalancers, containers, region);
  if (loadBalancers && 'error' in loadBalancers) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: loadBalancers.error,
    };
  }
  await ecs.send(
    new UpdateServiceCommand({
      cluster,
      service,
      taskDefinition: toArn,
      forceNewDeployment: true,
      ...(loadBalancers ? { loadBalancers } : {}),
    }),
  );
  const waited = await waitForServiceStable(ecs, ctx, cluster, service, toArn);
  if (!waited.ok) return waited;
  return {
    ok: true,
    kind: 'released',
    binding: 'ecs-fargate',
    from: fromArn,
    to: toArn,
    message: `Updated ${service} on ${cluster} to image tag ${imageTag}.`,
  };
}

// @intent Restore the receipt from task-def ARN; do not guess previous
export async function rollbackEcsFargate(ctx: ReleaseContext): Promise<BindingResult> {
  const restoreId = ctx.restoreGenerationId?.trim();
  if (!restoreId) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: 'ecs-fargate rollback requires restoreGenerationId (receipt from task definition ARN).',
    };
  }
  const { cluster, service } = resolveEcsReleaseIds(ctx);
  if (!service) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: 'ecs-fargate rollback requires --target-component or extras.service.',
    };
  }
  const region = process.env.AWS_REGION || 'us-east-1';
  const ecs = new ECSClient({ region });
  const described = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
  const current = described.services?.[0];
  if (!current?.taskDefinition) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: `ECS service ${service} not found in cluster ${cluster}. Apply first.`,
    };
  }
  const restore = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: restoreId }));
  const restoreArn = restore.taskDefinition?.taskDefinitionArn;
  if (!restoreArn) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: `Unknown restore task definition ${restoreId}. Fail closed.`,
    };
  }
  await ecs.send(
    new UpdateServiceCommand({
      cluster,
      service,
      taskDefinition: restoreArn,
      forceNewDeployment: true,
    }),
  );
  const waited = await waitForServiceStable(ecs, ctx, cluster, service, restoreArn);
  if (!waited.ok) return waited;
  return {
    ok: true,
    kind: 'released',
    binding: 'ecs-fargate',
    from: current.taskDefinition,
    to: restoreArn,
    message: `Rolled back ${service} on ${cluster} to task definition ${restoreArn}.`,
  };
}

function isCollectorRelease(ctx: ReleaseContext, service: string): boolean {
  return ctx.strategyKey === 'infra.observe.metrics' || service.endsWith('-collector');
}

function isDashboardRelease(ctx: ReleaseContext, service: string): boolean {
  return ctx.strategyKey === 'infra.observe.dashboard' || service.endsWith('-dashboard');
}

function isHttpAttachable(ctx: ReleaseContext, service: string): boolean {
  if (isCollectorRelease(ctx, service)) return false;
  if (ctx.strategyKey === 'infra.worker.temporal') return false;
  return true;
}

function dashboardComponentFromService(env: string, service: string): string {
  const prefix = `${env}-`;
  const body = service.startsWith(prefix) ? service.slice(prefix.length) : service;
  return body.replace(/-dashboard$/, '');
}

function minHealthyCount(ctx: ReleaseContext, service: string): number {
  // @intent Collector/Temporal stay DesiredCount 1; ignore staging standard scaling.min=2
  if (isCollectorRelease(ctx, service) || ctx.strategyKey === 'infra.worker.temporal') return 1;
  const resolved = resolvePortableExtras({ env: ctx.env, extras: ctx.extras });
  const fromExtras = extraNumber(resolved, 'scaling.min');
  if (fromExtras !== undefined) return fromExtras;
  return 2;
}

function shouldWait(ctx: ReleaseContext): boolean {
  return ctx.extras?.['deploy.wait'] !== false;
}

export type EcsServiceSnapshot = {
  runningCount?: number;
  desiredCount?: number;
  taskDefinition?: string;
  deployments?: Array<{
    status?: string;
    taskDefinition?: string;
    rolloutState?: string;
    runningCount?: number;
  }>;
};

// @intent PRIMARY of the new generation with minHealthy tasks is live even if ACTIVE is still draining
export function isPrimaryGenerationReady(input: {
  service?: EcsServiceSnapshot;
  expectedTaskDefinition: string;
  minHealthy: number;
}): boolean {
  const svc = input.service;
  if (!svc) return false;
  if ((svc.deployments ?? []).some((deployment) => deployment.rolloutState === 'FAILED')) return false;
  const primary =
    (svc.deployments ?? []).find((deployment) => deployment.status === 'PRIMARY') ??
    (svc.taskDefinition ? { taskDefinition: svc.taskDefinition, runningCount: svc.runningCount } : undefined);
  if (!primary || primary.taskDefinition !== input.expectedTaskDefinition) return false;
  const primaryRunning = primary.runningCount ?? 0;
  if (primaryRunning < input.minHealthy) return false;
  return primary.rolloutState !== 'FAILED';
}

// @intent Wait until PRIMARY is stable; size the waiter from the same extras apply uses for grace/drain
async function waitForServiceStable(
  ecs: ECSClient,
  ctx: ReleaseContext,
  cluster: string,
  service: string,
  expectedTaskDefinition: string,
): Promise<BindingResult | { ok: true }> {
  if (!shouldWait(ctx)) return { ok: true };
  const minHealthy = minHealthyCount(ctx, service);
  const maxWaitTime = stableWaitSeconds({ env: ctx.env, extras: ctx.extras });
  try {
    await waitUntilServicesStable({ client: ecs, maxWaitTime }, { cluster, services: [service] });
  } catch (error) {
    const afterTimeout = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
    if (
      isPrimaryGenerationReady({
        service: afterTimeout.services?.[0],
        expectedTaskDefinition,
        minHealthy,
      })
    ) {
      return { ok: true };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: `ECS service ${service} did not become stable: ${reason}`,
    };
  }
  const after = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
  const svc = after.services?.[0];
  if (typeof svc?.runningCount === 'number' && svc.runningCount < minHealthy) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'ecs-fargate',
      message: `ECS service ${service} runningCount ${svc.runningCount} is below scaling.min ${minHealthy}.`,
    };
  }
  return { ok: true };
}

type AttachResult =
  | Array<{ targetGroupArn: string; containerName: string; containerPort: number }>
  | { error: string }
  | undefined;

// @intent Attach in the same UpdateService as the pinned good image
async function resolveHttpAttach(
  ctx: ReleaseContext,
  service: string,
  currentLoadBalancers: Array<{ targetGroupArn?: string }> | undefined,
  containers: Array<{
    name?: string;
    image?: string;
    portMappings?: Array<{ containerPort?: number }>;
  }>,
  region: string,
): Promise<AttachResult> {
  if (!isHttpAttachable(ctx, service)) return undefined;
  if (currentLoadBalancers && currentLoadBalancers.length > 0) return undefined;
  if (containers.some((container) => isPauseContainerImage(container.image))) return undefined;
  const primary = containers[0];
  const containerName = primary?.name;
  const containerPort = primary?.portMappings?.[0]?.containerPort;
  if (!containerName || !containerPort) {
    return { error: `Cannot attach ${service}: container name or port is missing from the task definition.` };
  }
  const tgName = releaseTargetGroupName(ctx, service);
  const elbv2 = new ElasticLoadBalancingV2Client({ region });
  try {
    const described = await elbv2.send(new DescribeTargetGroupsCommand({ Names: [tgName] }));
    const targetGroupArn = described.TargetGroups?.[0]?.TargetGroupArn;
    if (!targetGroupArn) {
      return { error: `Target group ${tgName} not found for ${service}. Apply first.` };
    }
    return [{ targetGroupArn, containerName, containerPort }];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { error: `Target group ${tgName} lookup failed for ${service}: ${reason}` };
  }
}



