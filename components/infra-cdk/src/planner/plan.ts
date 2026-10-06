import fs from 'node:fs/promises';
import path from 'node:path';
import { collectDeploymentIntents } from './collector/deployment-intents';
import {
  CollectorOptions,
  DependencyGraph,
  DeploymentIntent,
  InfraStrategyRequirement,
  StrategyResolutionResult,
} from '../types';
import { SecretsProvider } from '../secrets/secrets-provider';
import { createFileSecretsProvider } from '../secrets/file-secrets-provider';
import { buildSecretPath, resolveRepoPath, sanitizeSegment } from '../utils/path-helpers';
import {
  DEFAULT_GIT_PASSWORD_SECRET_NAME,
  FALLBACK_ROOT_DOMAIN,
  readRootDomainFromThonnasPackage,
} from '../utils/root-domain';
import { resolveStrategies } from '../registry/resolve-strategies';
import { buildDependencyGraph } from '../graph/dependency-graph';
import { buildCdkApp } from '../cdk/app-builder';
import type { ReleasedContainer } from '../stacks/released-container';
import { detectHostedZoneForDomain } from '../utils/hosted-zone';
import { InjectedAwsState, resolveExistingState } from './existing-state';
import {
  classifyStackRows,
  listPlannedStacks,
  omitBlockedFromResolution,
  PlanStackRow,
} from './stack-status';
import { selectTargetIntents } from './target-closure';

export type { InjectedAwsState } from './existing-state';
export type { PlanStackRow, PlanStackStatus } from './stack-status';
export { formatPlanSummaryLines } from './stack-status';

export interface PlanOptions extends CollectorOptions {
  secretsProvider?: SecretsProvider;
  imageTag?: string;
  projectName?: string;
  /** AWS account ID for CDK env (e.g. 12-digit); from --account-id */
  accountId?: string;
  /** Region for CDK env (e.g. us-east-1); from --region */
  region?: string;
  cdkRuntimeModulePathOverride?: string;
  gitTag?: string;
  deploySlug?: string;
  strategyFilter?: string[];
  /** Cheap-slice / provider-injected AWS state. extras.existing is not read here. */
  existingState?: InjectedAwsState;
  /** Production HeadBucket before classify. Cheap tests inject bucketExists instead. */
  resolveBucketExists?: (bucketNames: string[]) => Promise<Record<string, boolean>>;
  resolveReleasedContainers?: (components: string[]) => Promise<Record<string, ReleasedContainer>>;
}

// @intent Exported so release job resolution can apply the identical monorepoDeploy collapse --
// otherwise release tries to release every individually-strategized component (fleet, ecs-fargate)
// even though apply folded them all into the one compose-host instance's docker-compose services.
export const filterIntentsForEnv = (intents: DeploymentIntent[], env: string): DeploymentIntent[] => {
  const match = intents.find((intent) => {
    const envStrategies = intent.environments[env] ?? intent.strategies;
    return Object.values(envStrategies).some((strategy) => strategy?.extras?.monorepoDeploy === true);
  });
  return match ? [match] : intents;
};

export interface ResolvedIntent {
  component: string;
  domain: string;
  strategies: Record<string, InfraStrategyRequirement>;
}

export interface SecretSummaryEntry {
  component: string;
  strategy?: string;
  path: string;
}

export interface ArtifactUploadEntry {
  component: string;
  version: string;
  paths: string[];
}

export interface PlanResult {
  env: string;
  intents: DeploymentIntent[];
  resolvedIntents: ResolvedIntent[];
  secrets: SecretSummaryEntry[];
  strategyResolution: StrategyResolutionResult;
  dependencyGraph: DependencyGraph;
  /** Resolved artifact paths that would be uploaded per component (same logic as apply). */
  artifactUploads: ArtifactUploadEntry[];
  outputPath: string;
  graphOutputPath: string;
  cdkAppPath: string;
  stackRows: PlanStackRow[];
}

const resolveRootDomain = async (
  options: PlanOptions,
  projectRoot: string,
): Promise<string> => {
  const fromOptions = options.rootDomain?.trim();
  if (fromOptions) return fromOptions;
  const fromPackage = await readRootDomainFromThonnasPackage(projectRoot);
  if (fromPackage) return fromPackage;
  const fromEnv = process.env.THONNAS_ROOT_DOMAIN?.trim();
  if (fromEnv) return fromEnv;
  return FALLBACK_ROOT_DOMAIN;
};

// @intent For prod/production, omit env and deploy-slug from hostnames so e.g. {deploy-slug}.{env}.api.{rootDomain} → api.{rootDomain}
const getEnvForHost = (env: string): string => {
  const lower = env.toLowerCase();
  return lower === 'prod' || lower === 'production' ? '' : env;
};

// @intent Pre-validated deploy slug from CLI; omit when empty or equals env (same rules as infra-cdk resolve-strategies)
const computeDeploySlugPrefix = (env: string, deploySlug: string | null | undefined): string => {
  if (env.toLowerCase() === 'prod' || env.toLowerCase() === 'production') return '';
  if (!deploySlug || !deploySlug.trim()) return '';
  const s = deploySlug.trim().toLowerCase();
  if (s === env.toLowerCase()) return '';
  return s;
};

// @intent After token replacement: strip leading period and collapse multiple periods to one
const postProcessHost = (value: string): string =>
  value == null || value === '' ? value : value.replace(/^\.+/, '').replace(/\.\.+/g, '.');

const resolveDomain = (intent: DeploymentIntent, env: string, rootDomain: string, deploySlug?: string): string => {
  const pattern =
    intent.environmentDomainPatterns?.[env] ||
    intent.domainPattern ||
    '{env}.{component}.{rootDomain}';
  const slugPrefix = computeDeploySlugPrefix(env, deploySlug ?? null);
  const envValue = getEnvForHost(env);
  const raw = pattern
    .replaceAll('{deploy-slug}', slugPrefix)
    .replaceAll('{env}', envValue)
    .replaceAll('{component}', intent.component)
    .replaceAll('{rootDomain}', rootDomain);
  return postProcessHost(raw);
};

const resolveStrategiesForEnv = (
  intent: DeploymentIntent,
  env: string,
): Record<string, InfraStrategyRequirement> => {
  const overrides = intent.environments[env];
  if (!overrides) return intent.strategies;
  return overrides;
};

const writeResolvedIntentsOutput = async (
  projectRoot: string,
  env: string,
  payload: ResolvedIntent[],
): Promise<string> => {
  const outputDir = resolveRepoPath(projectRoot, 'components', 'infra-cdk', 'generated', env);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'deployment-intents.json');
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return outputPath;
};

const writeGraphOutput = async (
  projectRoot: string,
  env: string,
  payload: DependencyGraph,
): Promise<string> => {
  const outputDir = resolveRepoPath(projectRoot, 'components', 'infra-cdk', 'generated', env);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'dependency-graph.json');
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return outputPath;
};

const ensureComposeHostHostedZone = async (
  strategies: Record<string, InfraStrategyRequirement>,
  rootDomain: string,
): Promise<void> => {
  const requirements = Object.values(strategies);
  const composeHostRequirement = requirements.find((requirement) => requirement?.key === 'infra.container.compose-host');
  if (!composeHostRequirement) {
    return;
  }

  const extras = composeHostRequirement.extras ?? {};
  if (extras.hostedZoneId && extras.hostedZoneName) {
    return;
  }

  const detected = await detectHostedZoneForDomain(rootDomain);
  if (!detected) {
    return;
  }

  composeHostRequirement.extras = {
    ...extras,
    hostedZoneId: extras.hostedZoneId ?? detected.id,
    hostedZoneName: extras.hostedZoneName ?? detected.name,
  };
};

// @intent Collect artifact/website/storage bucket names for HeadBucket import
const resourceBucketNames = (resolution: StrategyResolutionResult): string[] => {
  const names = new Set<string>();
  for (const resource of resolution.resources) {
    if (
      resource.kind !== 's3ArtifactDeployment' &&
      resource.kind !== 's3WebsiteBucket' &&
      resource.kind !== 's3StorageBucket'
    ) {
      continue;
    }
    const raw =
      (typeof resource.props?.bucket === 'string' ? resource.props.bucket : undefined) ??
      (typeof resource.props?.bucketName === 'string' ? resource.props.bucketName : undefined) ??
      '';
    if (raw.trim()) names.add(raw.trim());
  }
  return [...names];
};

// @intent Merge HeadBucket results into injected state before classify
const mergeBucketExists = async (
  options: PlanOptions,
  resolution: StrategyResolutionResult,
): Promise<InjectedAwsState | undefined> => {
  if (!options.resolveBucketExists) return options.existingState;
  const names = resourceBucketNames(resolution);
  if (names.length === 0) return options.existingState;
  const found = await options.resolveBucketExists(names);
  return {
    ...options.existingState,
    bucketExists: { ...(options.existingState?.bucketExists ?? {}), ...found },
  };
};

export const planInfrastructure = async (options: PlanOptions): Promise<PlanResult> => {
  const rawEnv = options.env;
  const env = sanitizeSegment(rawEnv) || rawEnv;
  const projectRoot = options.projectRoot;
  const rootDomain = await resolveRootDomain(options, projectRoot);
  const gitPasswordSecretName = DEFAULT_GIT_PASSWORD_SECRET_NAME;
  const imageTag = options.imageTag ?? 'latest';
  const allIntents = await collectDeploymentIntents(options);
  // @intent Narrow --target-component to the target plus the providers its stacks consume
  const collectedIntents = options.targetComponents?.length
    ? selectTargetIntents(
        allIntents,
        resolveStrategies(allIntents, {
          env,
          rootDomain,
          projectRoot,
          gitTag: options.gitTag,
          deploySlug: options.deploySlug,
          gitPasswordSecretName,
          projectName: options.projectName,
        }),
        options.targetComponents,
      )
    : allIntents;
  const intents = filterIntentsForEnv(collectedIntents, env);

  const secretsProvider =
    options.secretsProvider ?? createFileSecretsProvider({ projectRoot: options.projectRoot, env });

  const resolvedIntents: ResolvedIntent[] = [];
  const secretSummary: SecretSummaryEntry[] = [];
  const seenSecretPaths = new Set<string>();

  for (const intent of intents) {
    const strategies = resolveStrategiesForEnv(intent, env);
    await ensureComposeHostHostedZone(strategies, rootDomain);
    resolvedIntents.push({
      component: intent.component,
      domain: resolveDomain(intent, env, rootDomain, options.deploySlug),
      strategies,
    });

    for (const secret of intent.requiredSecrets) {
      const secretPath = buildSecretPath(env, intent.component, secret.name);
      if (!seenSecretPaths.has(secretPath)) {
        await secretsProvider.ensureSecret(secretPath);
        seenSecretPaths.add(secretPath);
        secretSummary.push({
          component: intent.component,
          strategy: secret.strategy,
          path: secretPath,
        });
      }
    }
  }

  const sanitizedPayload = resolvedIntents.map((intent) => ({
    ...intent,
    requiredSecrets: secretSummary
      .filter((entry) => entry.component === intent.component)
      .map((entry) => ({ path: entry.path, value: '***managed***' })),
  }));

  // @intent Resolve strategies from ALL intents so infra.storage (and other resources) from every component are planned; filtered intents still drive which component(s) get stacks
  let strategyResolution = resolveStrategies(collectedIntents, {
    env,
    rootDomain,
    projectRoot,
    gitTag: options.gitTag,
    deploySlug: options.deploySlug,
    gitPasswordSecretName,
    strategyFilter: options.strategyFilter,
    projectName: options.projectName,
  });
  // Keep only components that are in the filtered intents (e.g. monorepo deploy = one ComposeHost); keep all resources so ComposeHost gets every s3StorageBucket
  const intentComponentSet = new Set(intents.map((i) => i.component));
  strategyResolution = {
    ...strategyResolution,
    components: strategyResolution.components.filter((c) => intentComponentSet.has(c.component)),
  };

  // @intent Classify statuses before CDK app so blocked Temporal/HTTP do not throw at synth
  const existing = resolveExistingState(await mergeBucketExists(options, strategyResolution));
  const planned = listPlannedStacks(strategyResolution, env, options.projectName, options.deploySlug);
  const classified = classifyStackRows(planned, existing, strategyResolution, env);
  const deployResolution = omitBlockedFromResolution(strategyResolution, classified.omitKeys);

  // @intent Apply does not upload app files; release owns s3-artifact generations
  const artifactUploads: PlanResult['artifactUploads'] = [];

  const dependencyGraph = buildDependencyGraph(env, intents, deployResolution);
  const releasedComponents = deployResolution.components
    .filter((component) => component.metadata.runtimeType === 'ecs-fargate')
    .map((component) => component.component);
  const releasedContainers =
    releasedComponents.length && options.resolveReleasedContainers
      ? await options.resolveReleasedContainers(releasedComponents)
      : undefined;
  const cdkAppPath = await buildCdkApp({
    projectRoot,
    env,
    graph: dependencyGraph,
    resolution: deployResolution,
    imageTag,
    gitTag: options.gitTag,
    deploySlug: options.deploySlug,
    projectName: options.projectName,
    releasedContainers,
    accountId: options.accountId,
    region: options.region,
    rootDomain,
    runtimeModulePathOverride: options.cdkRuntimeModulePathOverride,
  });

  const outputPath = await writeResolvedIntentsOutput(projectRoot, env, sanitizedPayload);
  const graphOutputPath = await writeGraphOutput(projectRoot, env, dependencyGraph);

  return {
    env,
    intents,
    resolvedIntents,
    secrets: secretSummary,
    strategyResolution,
    dependencyGraph,
    artifactUploads,
    outputPath,
    graphOutputPath,
    cdkAppPath,
    stackRows: classified.rows,
  };
};





