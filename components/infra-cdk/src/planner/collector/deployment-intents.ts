import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  deploymentSpecSchema,
  definitionBlockSchema,
  environmentBlockSchema,
  ComponentEndpoints,
  DerivationDescriptor,
  DeploymentIntent,
  CollectorOptions,
  InfraStrategyRequirement,
  InfraStrategyOverride,
  SecretRequest,
} from '../../types';
import { sanitizeSegment } from '../../utils/path-helpers';

const execFileAsync = promisify(execFile);

const DEFAULT_DOMAIN_PATTERN = '{env}.{component}.{rootDomain}';

// @intent Merge base and override strategy requirements with deep semantics
const normalizeSecrets = (
  secrets?: InfraStrategyOverride['secrets'],
): InfraStrategyRequirement['secrets'] => {
  if (!secrets) return secrets;
  return secrets
    .filter((secret): secret is Required<InfraStrategyOverride>['secrets'][number] => Boolean(secret?.name))
    .map((secret) => ({
      name: secret!.name!,
      description: secret?.description,
      generator: secret?.generator ?? 'random32',
    }));
};

const mergeStrategyRequirement = (
  base: InfraStrategyRequirement,
  override?: InfraStrategyOverride,
): InfraStrategyRequirement => {
  if (!override) return { ...base };
  // @intent Preserve passthrough fields (e.g. bucket for infra.storage) by spreading override after known fields
  return {
    ...base,
    ...override,
    key: override.key ?? base.key,
    ports: override.ports ?? base.ports,
    exposed: override.exposed ?? base.exposed,
    scaling: override.scaling
      ? {
          min: override.scaling.min ?? base.scaling?.min,
          max: override.scaling.max ?? base.scaling?.max,
        }
      : base.scaling,
    engine: override.engine ?? base.engine,
    extras: override.extras ? { ...(base.extras ?? {}), ...override.extras } : base.extras,
    secrets: override.secrets ? normalizeSecrets(override.secrets) : base.secrets,
  };
};

const normalizeDomainPattern = (pattern?: string): string => {
  if (!pattern || !pattern.includes('{component}')) {
    return DEFAULT_DOMAIN_PATTERN;
  }
  return pattern;
};

const collectSecretRequests = (
  component: string,
  strategyName: string,
  requirement: InfraStrategyRequirement,
): SecretRequest[] => {
  if (!requirement.secrets?.length) {
    return [];
  }
  return requirement.secrets.map((secret) => ({
    name: secret.name,
    scope: 'strategy' as const,
    strategy: strategyName,
    description: secret.description,
    generator: secret.generator ?? 'random32',
  }));
};

const readJsonIfExists = async <T>(filePath: string): Promise<T | undefined> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      const rel = path.relative(process.cwd(), path.resolve(filePath));
      throw new Error(`${rel}: invalid JSON - ${error.message}`);
    }
    throw error;
  }
};

function isDirectoryOrSymlinkToDir(dirPath: string): Promise<boolean> {
  return fs.stat(dirPath).then((s) => s.isDirectory()).catch(() => false);
}

// @intent Shared parsing for both components/* and .thonnas/libs/* sources — a lib (e.g.
// cicd-github-actions declaring infra.identity.oidc) is a project-wide/shared strategy declarer,
// not a per-app deployable component, but its thonnas-infra.json uses the exact same shape.
const buildIntentFromInfraFile = async (
  component: string,
  componentDir: string,
  componentPathLabel: string,
): Promise<DeploymentIntent | undefined> => {
  {
      const infraFile = path.join(componentDir, 'thonnas-infra.json');
      let spec = await readJsonIfExists<Record<string, unknown>>(infraFile);
      if (!spec) return undefined;
      const genPath = path.join(componentDir, 'generated', 'thonnas-infra.generated.json');
      const genJson = await readJsonIfExists<{ publishedServices?: unknown }>(genPath);
      if (genJson?.publishedServices && Array.isArray(genJson.publishedServices) && spec) {
        const merged = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
        const def = (merged.default ??= {}) as Record<string, unknown>;
        const strategies = (def.strategies ??= {}) as Record<string, unknown>;
        const composeHost = (strategies.composeHost ??= {}) as Record<string, unknown>;
        const extras = (composeHost.extras ??= {}) as Record<string, unknown>;
        extras.publishedServices = genJson.publishedServices;
        spec = merged;
      }
      const parsed = deploymentSpecSchema.safeParse(spec);
      if (!parsed.success) {
        const message = parsed.error.errors.map((err) => `${err.path.join('.')}: ${err.message}`).join('; ');
        throw new Error(`Invalid thonnas-infra.json for component "${component}": ${message}`);
      }
      const { thonnasInfraVersion, default: defaultBlock, environments: topLevelEnvs, ...maybeEnvs } = parsed.data;
      // @intent Merge environments{} with top-level env blocks (staging/production); do not drop either.
      // Previously this was a shallow object-spread per env name, which -- when a component declares
      // the SAME env both as a top-level sibling (e.g. `"beta": {...}`) and nested under `environments`
      // (e.g. `environments.beta`, commonly used to layer extra derivations on) -- silently discarded
      // the top-level block's `strategies`/`endpoints`/`derivations` entirely, keeping only whatever the
      // environments.X block happened to declare. Merge each of those sub-fields explicitly instead.
      const topLevelEnvsMap = maybeEnvs as Record<string, Record<string, unknown> | undefined>;
      const nestedEnvsMap = (topLevelEnvs as Record<string, Record<string, unknown> | undefined> | undefined) ?? {};
      const envNames = new Set([...Object.keys(topLevelEnvsMap), ...Object.keys(nestedEnvsMap)]);
      const mergeSubField = <T>(
        a: T | undefined,
        b: T | undefined,
        combine: (a: T, b: T) => T,
      ): T | undefined => {
        if (a === undefined) return b;
        if (b === undefined) return a;
        return combine(a, b);
      };
      const envSource: Record<string, unknown> = {};
      for (const envName of envNames) {
        const fromTopLevel = topLevelEnvsMap[envName];
        const fromNested = nestedEnvsMap[envName];
        const merged: Record<string, unknown> = { ...(fromTopLevel ?? {}), ...(fromNested ?? {}) };
        const strategies = mergeSubField(
          fromTopLevel?.strategies as Record<string, unknown> | undefined,
          fromNested?.strategies as Record<string, unknown> | undefined,
          (x, y) => ({ ...x, ...y }),
        );
        const endpoints = mergeSubField(
          fromTopLevel?.endpoints as Record<string, unknown> | undefined,
          fromNested?.endpoints as Record<string, unknown> | undefined,
          (x, y) => ({ ...x, ...y }),
        );
        const derivations = mergeSubField(
          fromTopLevel?.derivations as unknown[] | undefined,
          fromNested?.derivations as unknown[] | undefined,
          (x, y) => [...x, ...y],
        );
        if (strategies !== undefined) merged.strategies = strategies;
        if (endpoints !== undefined) merged.endpoints = endpoints;
        if (derivations !== undefined) merged.derivations = derivations;
        envSource[envName] = merged;
      }
      const baseDefinitionResult = definitionBlockSchema.safeParse(defaultBlock);
      if (!baseDefinitionResult.success) {
        const message = baseDefinitionResult.error.errors
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        throw new Error(`Invalid default definition for component "${component}": ${message}`);
      }
      const baseDefinition = baseDefinitionResult.data;
      const baseStrategies = baseDefinition.strategies ?? {};

      // @intent Count env-only strategies (e.g. dbt-postgres relational under staging only)
      const envStrategyCount = Object.values(envSource as Record<string, unknown>).reduce((count: number, block) => {
        if (!block || typeof block !== 'object' || Array.isArray(block)) return count;
        const strategies = (block as { strategies?: Record<string, unknown> }).strategies;
        return count + (strategies && typeof strategies === 'object' ? Object.keys(strategies).length : 0);
      }, 0);

      // @intent Skip components with no deployable strategies (e.g. endpoints-only for config/derivations)
      if (Object.keys(baseStrategies).length === 0 && envStrategyCount === 0) {
        return undefined;
      }

      const normalizedStrategies = Object.fromEntries(
        Object.entries(baseStrategies).map(([name, requirement]) => [name, { ...requirement }]),
      );

      const secretMap = new Map<string, SecretRequest>();
      const addSecrets = (items: SecretRequest[]) => {
        items.forEach((secret) => {
          const key = `${secret.strategy ?? 'component'}:${secret.name}`;
          secretMap.set(key, secret);
        });
      };

      Object.entries(normalizedStrategies).forEach(([strategyName, requirement]) => {
        addSecrets(collectSecretRequests(component, strategyName, requirement));
      });

      const envOverrides: Record<string, Record<string, InfraStrategyRequirement>> = {};
      const environmentEndpoints: Record<string, ComponentEndpoints | undefined> = {};
      const environmentDerivations: Record<string, DerivationDescriptor[] | undefined> = {};
      const environmentDomainPatterns: Record<string, string> = {};
      const envEntries = Object.entries(envSource as Record<string, unknown>).filter(
        (entry): entry is [string, Record<string, unknown>] =>
          typeof entry[1] === 'object' && entry[1] !== null && !Array.isArray(entry[1]),
      );
      envEntries.forEach(([envName, definition]) => {
        const result = environmentBlockSchema.safeParse(definition);
        if (!result.success) {
          const message = result.error.errors.map((err) => `${err.path.join('.')}: ${err.message}`).join('; ');
          throw new Error(`Invalid environment definition "${envName}" for component "${component}": ${message}`);
        }
        const block = result.data;
        const sanitizedEnv = sanitizeSegment(envName) || envName;
        envOverrides[sanitizedEnv] = {};
        if (typeof block.domain === 'string' && block.domain.trim()) {
          environmentDomainPatterns[sanitizedEnv] = normalizeDomainPattern(block.domain);
        }
        const overrideStrategies = block.strategies ?? {};
        const strategyNames = new Set([
          ...Object.keys(normalizedStrategies),
          ...Object.keys(overrideStrategies),
        ]);
        strategyNames.forEach((strategyName) => {
          const baseRequirement = normalizedStrategies[strategyName];
          const override = overrideStrategies[strategyName];
          let merged: InfraStrategyRequirement | undefined;
          if (baseRequirement) {
            merged = mergeStrategyRequirement(baseRequirement, override);
          } else if (override) {
            // @intent Preserve passthrough fields (e.g. bucket) by spreading override
            const syntheticBase: InfraStrategyRequirement = {
              ...override,
              key: override.key ?? strategyName,
              ports: override.ports,
              exposed: override.exposed,
              scaling: override.scaling as InfraStrategyRequirement['scaling'],
              engine: override.engine,
              extras: override.extras as Record<string, unknown> | undefined,
              secrets: normalizeSecrets(override.secrets),
            };
            merged = mergeStrategyRequirement(syntheticBase, override);
          }
          if (merged) {
            envOverrides[sanitizedEnv][strategyName] = merged;
            addSecrets(collectSecretRequests(component, strategyName, merged));
          }
        });
        environmentEndpoints[sanitizedEnv] = block.endpoints;
        environmentDerivations[sanitizedEnv] = block.derivations;
      });

      return {
        component,
        componentPath: componentPathLabel,
        thonnasInfraVersion,
        domainPattern: normalizeDomainPattern(baseDefinition.domain),
        environmentDomainPatterns:
          Object.keys(environmentDomainPatterns).length > 0 ? environmentDomainPatterns : undefined,
        strategies: normalizedStrategies,
        environments: envOverrides,
        requiredSecrets: Array.from(secretMap.values()),
        endpoints: baseDefinition.endpoints,
        environmentEndpoints,
        derivations: baseDefinition.derivations,
        environmentDerivations,
      };
  }
};

interface StrategyMappingResolution {
  strategy: string;
  consumer: string;
  purpose: string;
  resolvedTo: string;
}

interface StrategyMappingFile {
  schemaVersion: string;
  resolutions: StrategyMappingResolution[];
}

// @intent Read-only FEAT-011 check: infra-cdk never writes .thonnas/strategy-mapping.json,
// it only ever validates against what thonnas component/module install already committed.
const failClosedOnDanglingStrategyResolutions = async (
  projectRoot: string,
  intents: DeploymentIntent[],
): Promise<void> => {
  const mappingPath = path.join(projectRoot, '.thonnas', 'strategy-mapping.json');
  let mapping: StrategyMappingFile;
  try {
    mapping = JSON.parse(await fs.readFile(mappingPath, 'utf8'));
  } catch {
    return; // No mapping file yet, or nothing recorded -- nothing to check.
  }
  if (!mapping.resolutions?.length) return;

  const installed = new Set(intents.map((intent) => intent.component));
  const dangling = mapping.resolutions.filter((resolution) => !installed.has(resolution.resolvedTo));
  if (dangling.length === 0) return;

  const details = dangling
    .map(
      (r) =>
        `  - "${r.consumer}" (strategy: ${r.strategy}, purpose: ${r.purpose}) resolved to "${r.resolvedTo}", which is not an installed component/lib`,
    )
    .join('\n');
  throw new Error(
    `Strategy resolution is out of date -- .thonnas/strategy-mapping.json references components that are no longer installed:\n${details}\n` +
      'Re-run thonnas component/module install to re-resolve, or fix .thonnas/strategy-mapping.json directly.',
  );
};

interface InfraGraphEdge {
  from: string;
  to: string;
}

interface InfraGraphFile {
  edges?: InfraGraphEdge[];
}

// @intent `thonnas infra graph`'s own convention (defaultInfraGraphPath in thonnas-cli's
// infra-graph.ts) -- read the committed/generated file first so a project that already ran
// `thonnas infra graph` doesn't pay for a re-generation on every release.
const infraGraphPath = (projectRoot: string, env: string): string =>
  path.join(projectRoot, 'project', 'generated', `infra-graph.${env}.json`);

// @intent Once a single attempt shows the installed thonnas CLI can't run `infra graph` (too
// old, or genuinely erroring), don't pay a full subprocess spawn on every subsequent call within
// this process -- there's no reason to expect a different result, and on Windows a slow/hanging
// child process can also race directory cleanup in callers that tear down a temp projectRoot
// right after (observed as EBUSY on rmdir in tests). Reset is never needed in production (one
// `thonnas release` invocation is one process); test files that need to exercise both outcomes
// should reset it explicitly.
let infraGraphCliUnavailable = false;

export const _resetInfraGraphCliAvailabilityForTests = (): void => {
  infraGraphCliUnavailable = false;
};

// @intent Release ordering is a best-effort improvement, never a new hard dependency -- any
// failure here (file missing, stale/corrupt JSON, the installed thonnas CLI predating `infra
// graph`, the command itself throwing on a real deployed env) falls back to undefined, which
// topoSortByDependencyGraph treats identically to "no graph available" (today's alphabetical
// order), not a `thonnas release` failure.
const loadInfraGraph = async (projectRoot: string, env: string): Promise<InfraGraphFile | undefined> => {
  const committedPath = infraGraphPath(projectRoot, env);
  const fromFile = await readJsonIfExists<InfraGraphFile>(committedPath);
  if (fromFile?.edges) return fromFile;
  if (infraGraphCliUnavailable) return undefined;
  // @intent Test hermeticity: whether this subprocess call succeeds, fails fast, or hangs
  // depends entirely on whatever `thonnas` binary happens to be on the machine's PATH --
  // ambient, non-deterministic state a unit test must never depend on (confirmed: upgrading the
  // local CLI build turned this from an instant "unknown command" failure into a real, much
  // slower invocation, which alone was enough to blow past this file's test suite's timeouts).
  // Production behavior is completely unaffected; only test runs set this.
  if (process.env.THONNAS_SKIP_INFRA_GRAPH_CLI === '1') return undefined;

  try {
    // @intent Bounded timeout -- a hung/slow child process must never block a release, and on
    // Windows a still-exiting process can hold its cwd open against a caller's cleanup.
    const { stdout } = await execFileAsync('thonnas', ['infra', 'graph', '--env', env, '--stdout'], {
      cwd: projectRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    });
    return JSON.parse(stdout) as InfraGraphFile;
  } catch (error) {
    infraGraphCliUnavailable = true;
    console.warn(
      `[release-order] Could not generate the dependency graph via "thonnas infra graph" -- falling back to ` +
        `alphabetical release order. (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
};

// @intent Dependency-aware release order (Kahn's algorithm), stable-tiebroken alphabetically at
// every choice point so unrelated components keep today's deterministic, reviewable ordering.
// KNOWN LIMITATION (shared with the strategy-mapping check above): matches graph edges against
// bare component/lib folder names, not componentKey::alias instance keys -- correct for every
// unaliased component (the common case, every component in this project today) but an edge whose
// endpoints don't literally match a current intent is simply ignored, not a crash. Any failure to
// derive a full order (a real cycle, or no usable graph at all) falls back to the plain
// alphabetical sort -- ordering is an improvement, never a new way for `thonnas release` to break.
const topoSortByDependencyGraph = (intents: DeploymentIntent[], graph: InfraGraphFile | undefined): DeploymentIntent[] => {
  const alphabetical = [...intents].sort((a, b) => a.component.localeCompare(b.component));
  if (!graph?.edges?.length) return alphabetical;

  const names = alphabetical.map((intent) => intent.component);
  const nameSet = new Set(names);
  const byComponent = new Map(alphabetical.map((intent) => [intent.component, intent]));

  const dependsOn = new Map<string, Set<string>>(names.map((name) => [name, new Set<string>()]));
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    if (!nameSet.has(edge.from) || !nameSet.has(edge.to)) continue;
    dependsOn.get(edge.from)!.add(edge.to);
  }

  const remaining = new Set(names);
  const sortedNames: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) => [...dependsOn.get(name)!].every((dep) => !remaining.has(dep)))
      .sort((a, b) => a.localeCompare(b));
    if (ready.length === 0) {
      console.warn(
        `[release-order] Dependency cycle detected among: ${[...remaining].sort().join(', ')} -- falling back to ` +
          'alphabetical release order for this batch.',
      );
      return alphabetical;
    }
    const next = ready[0];
    sortedNames.push(next);
    remaining.delete(next);
  }

  return sortedNames.map((name) => byComponent.get(name)!);
};

export const collectDeploymentIntents = async (options: CollectorOptions): Promise<DeploymentIntent[]> => {
  const componentsDir = path.resolve(options.projectRoot, 'components');
  const entries = await fs.readdir(componentsDir, { withFileTypes: true });
  const intents: DeploymentIntent[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const componentDir = path.join(componentsDir, entry.name);
      if (!(await isDirectoryOrSymlinkToDir(componentDir))) return;
      const component = entry.name;
      if (component === 'infra-cdk') return;
      // @intent Keep non-target packages; planInfrastructure narrows to the target's dependency closure
      const intent = await buildIntentFromInfraFile(component, componentDir, path.join('components', component));
      if (intent) intents.push(intent);
    }),
  );

  // @intent Also scan installed libs (.thonnas/libs/*) for project-wide/shared strategy
  // declarations (e.g. cicd-github-actions declaring infra.identity.oidc) — libs are not
  // per-app deployable components, so --target-component never filters them out, and there is
  // no infra-cdk-style self-exclusion since a lib can't be "infra-cdk" itself.
  const libsDir = path.join(options.projectRoot, '.thonnas', 'libs');
  if (await isDirectoryOrSymlinkToDir(libsDir)) {
    const libEntries = await fs.readdir(libsDir, { withFileTypes: true });
    await Promise.all(
      libEntries.map(async (entry) => {
        const libDir = path.join(libsDir, entry.name);
        if (!(await isDirectoryOrSymlinkToDir(libDir))) return;
        const intent = await buildIntentFromInfraFile(entry.name, libDir, path.join('.thonnas', 'libs', entry.name));
        if (intent) intents.push(intent);
      }),
    );
  }

  const infraGraph = await loadInfraGraph(options.projectRoot, options.env);
  const sorted = topoSortByDependencyGraph(intents, infraGraph);

  // @intent Fail closed (AC-3.3, FEAT-011): read-only check against
  // .thonnas/strategy-mapping.json. infra-cdk never prompts, never calls AI,
  // and never re-derives a strategy resolution -- it only ever reads what
  // `thonnas component/module install` already committed. If a recorded
  // resolvedTo component is no longer present, that must be a loud error
  // here, not a silently-wrong deploy.
  // KNOWN LIMITATION: this compares resolvedTo against bare component/lib
  // folder names, not the componentKey::alias instance-key format
  // cli-node-thonnas-cli's ComponentRegistry produces. Correct for every
  // unaliased component (the common case, and every component in this
  // project today) but blind to a resolvedTo naming an *aliased* instance --
  // infra-cdk has no alias-aware component model yet (no `thonnas.alias`
  // read anywhere in this collector). Closing that gap means teaching this
  // collector the same instance-key convention, which is a larger, separate
  // change to infra-cdk's own metadata model.
  await failClosedOnDanglingStrategyResolutions(options.projectRoot, sorted);

  // @intent Fail closed when --target-component names a missing app package
  if (options.targetComponents?.length) {
    const found = new Set(sorted.map((intent) => intent.component));
    const missing = options.targetComponents.filter((key) => !found.has(key));
    if (missing.length) {
      throw new Error(
        `--target-component ${missing.join(', ')} did not match any components/*/thonnas-infra.json under the project root.`,
      );
    }
  }
  return sorted;
};





