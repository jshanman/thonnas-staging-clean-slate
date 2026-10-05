#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { normalizeEndpointSet as normalizeEndpointSetLib, type NormalizedEndpointSet } from './lib/normalize-endpoints.js';
import { resolveRepoRoot } from './lib/resolve-repo-root.js';

// @intent Build URL from endpoint, omitting default ports (443 for https, 80 for http)
const buildUrl = (endpoint: EndpointDescriptor | undefined): string => {
  if (!endpoint) return '';
  if (endpoint.url) return endpoint.url;
  const protocol = endpoint.protocol ?? 'https';
  const host = endpoint.host ?? 'localhost';
  const port = endpoint.port;
  const defaultPorts: Record<string, number> = { http: 80, https: 443 };
  const includePort = port !== undefined && port !== defaultPorts[protocol.toLowerCase()];
  return includePort ? `${protocol}://${host}:${port}` : `${protocol}://${host}`;
};

// @intent Create Handlebars instance with url helper for smart URL generation
const createTemplateEngine = () => {
  const hbs = Handlebars.create();
  hbs.registerHelper('url', (endpoint: EndpointDescriptor | undefined) => buildUrl(endpoint));
  return hbs;
};

const hbsRenderTemplate = (template: string, context: Record<string, unknown>): string => {
  const engine = createTemplateEngine();
  return engine.compile(template, { noEscape: true })(context);
};

interface EndpointDescriptor {
  host?: string;
  port?: number;
  protocol?: string;
  role?: string;
  tags?: string[];
  url?: string;
}

interface EndpointSet {
  hostnamePattern?: string;
  default?: EndpointDescriptor;
  endpoints?: EndpointDescriptor[];
  primary?: EndpointDescriptor;
  /** Arbitrary role keys from infra so {{endpoints.internal.<key>.host}} works without hardcoding. */
  roleKeyed?: Record<string, EndpointDescriptor>;
}

// @intent Expose all role keys so templates can use {{endpoints.internal.primary.host}}, {{endpoints.internal.dashboard.host}}, etc.
const toEndpointSet = (n: NormalizedEndpointSet | undefined): EndpointSet | undefined => {
  if (!n) return undefined;
  const out: EndpointSet = {
    hostnamePattern: n.hostnamePattern,
    default: n.default,
    primary: n.default,
    endpoints: n.endpoints,
    roleKeyed: n.roleKeyed,
  };
  if (n.roleKeyed) {
    for (const [key, value] of Object.entries(n.roleKeyed)) {
      if (RESERVED_SET_KEYS.has(key)) continue;
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
};
const normalizeEndpointSet = (raw: unknown): EndpointSet | undefined => toEndpointSet(normalizeEndpointSetLib(raw));

interface ComponentEndpoints {
  internal?: EndpointSet;
  external?: EndpointSet;
}

interface DerivationDescriptor {
  name: string;
  type?: 'config' | 'secret';
  description?: string;
  path?: string;
  templateType?: 'string' | 'json';
  source?: string;
  sourcePath?: string;
  resolverModule?: string;
  options?: Record<string, unknown>;
  secretSourceType?: 'generated' | 'user-provided';
}

interface DefinitionBlock {
  domain?: string;
  strategies?: Record<string, unknown>;
  endpoints?: ComponentEndpoints;
  derivations?: DerivationDescriptor[];
}

interface ParsedInfra {
  key: string;
  version: number;
  defaultBlock: DefinitionBlock;
  environments: Record<string, DefinitionBlock>;
}

interface ResolverContext {
  component: string;
  env: string;
  rootDomain: string;
  endpoints?: ComponentEndpoints;
  options?: Record<string, unknown>;
  allComponents: Record<string, { endpoints?: ComponentEndpoints }>;
}

interface ResolverResult {
  value: unknown;
  path?: string;
  description?: string;
  type?: 'config' | 'secret';
  format?: 'string' | 'json';
  secretSourceType?: 'generated' | 'user-provided';
}

interface ConfigExportMeta {
  name: string;
  description?: string;
  selfImportPath?: string;
  default?: unknown;
  format?: 'string' | 'json';
  /** Component that produced this export; resolution reads from config[env][componentKey] for infra imports */
  componentKey?: string;
}

// @intent For prod/production, omit env and deploy-slug from hostnames so e.g. {deploy-slug}.{env}.api.{rootDomain} → api.{rootDomain}
const getEnvForHost = (env: string): string => {
  const lower = env.toLowerCase();
  return lower === 'prod' || lower === 'production' ? '' : env;
};

// @intent Compute value for {deploy-slug} placeholder; slug is CLI-pre-validated
const computeDeploySlugPrefix = (env: string, deploySlug: string | null | undefined): string => {
  const lowerEnv = env.toLowerCase();
  if (lowerEnv === 'prod' || lowerEnv === 'production') return '';
  if (!deploySlug || !deploySlug.trim()) return '';
  const s = deploySlug.trim().toLowerCase();
  if (s === lowerEnv) return '';
  return s;
};

// @intent After token replacement: strip leading period and collapse multiple periods to one (pattern can use {deploy-slug}.{env})
const postProcessHost = (value: string | undefined): string | undefined => {
  if (value == null || value === '') return value;
  return value.replace(/^\.+/, '').replace(/\.\.+/g, '.');
};

// @intent Allow standalone runs with explicit env/root-domain/deploy-slug; prefer CLI args over process.env
function parseEnvFromArgv(
  argv: string[],
): { env: string | null; rootDomain: string | null; deploySlug: string | null } {
  let env: string | null = null;
  let rootDomain: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env' && argv[i + 1]) {
      env = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--env=')) {
      env = arg.slice(6);
    } else if (arg === '--root-domain' && argv[i + 1]) {
      rootDomain = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--root-domain=')) {
      rootDomain = arg.slice(14);
    }
  }
  const deploySlugFromArg = (() => {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--deploy-slug' && argv[i + 1]) {
        return argv[i + 1];
      }
      if (arg.startsWith('--deploy-slug=')) {
        return arg.slice('--deploy-slug='.length);
      }
    }
    return null;
  })();
  return { env, rootDomain, deploySlug: deploySlugFromArg };
}
const cliEnv = parseEnvFromArgv(process.argv.slice(2));
/** Single env for this run (--env or THONNAS_ENV). pickBlockForEnv falls back to default when component has no block for this env. */
const ENV = cliEnv.env ?? process.env.THONNAS_ENV ?? 'development';
/** Set in main() from resolveRootDomainForGenerate so beta gets THONNAS_ROOT_DOMAIN from project config */
let ROOT_DOMAIN = process.env.THONNAS_LOCAL_ROOT ?? 'localhost';
/** Optional deploy slug for `{deploy-slug}` host placeholder; from CLI or THONNAS_DEPLOY_SLUG. */
const RAW_DEPLOY_SLUG = cliEnv.deploySlug ?? process.env.THONNAS_DEPLOY_SLUG ?? null;
const RESERVED_KEYS = new Set([
  'thonnasInfraVersion',
  'version',
  'default',
  'strategies',
  'endpoints',
  'derivations',
  'domain',
  'environments',
]);

/** @intent Resolve root domain: CLI and THONNAS_ROOT_DOMAIN first; then project/config.json for current env so beta gets correct domain */
async function resolveRootDomainForGenerate(
  env: string,
  cliRootDomain: string | null,
  projectRoot: string,
): Promise<string> {
  if (cliRootDomain?.trim()) return cliRootDomain.trim();
  const fromEnv = process.env.THONNAS_ROOT_DOMAIN?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.THONNAS_LOCAL_ROOT?.trim()) return process.env.THONNAS_LOCAL_ROOT.trim();
  const projectConfigPath = path.join(projectRoot, 'project', 'config.json');
  try {
    const raw = await fs.readFile(projectConfigPath, 'utf8');
    const config = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const envBlock = config[env];
    const defaultBlock = config.default;
    const domain =
      (typeof envBlock?.THONNAS_ROOT_DOMAIN === 'string' && (envBlock.THONNAS_ROOT_DOMAIN as string).trim()) ||
      (typeof defaultBlock?.THONNAS_ROOT_DOMAIN === 'string' && (defaultBlock.THONNAS_ROOT_DOMAIN as string).trim());
    if (domain) return domain;
  } catch {
    // ignore missing or invalid project config
  }
  return 'localhost';
}

// @intent Outputs go to project's infra-docker/generated/ when THONNAS_REPO_ROOT or cwd-based resolution (dev-link)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRoot(__dirname);
const componentDir = path.join(repoRoot, 'components', 'infra-docker');
const componentsDir = path.join(repoRoot, 'components');
const generatedDir = path.join(componentDir, 'generated');
const configOutputFile = path.join(generatedDir, 'thonnas-config.generated.json');
const secretsOutputFile = path.join(generatedDir, 'thonnas-secrets.generated.json');

// @intent Recursively collect all thonnas-infra.json files under /components (components + modules)
// @intent For infra-docker, loadComponents merges generated/thonnas-infra.generated.json (publishedServices) into base
const collectInfraFiles = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      const nested = await collectInfraFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile() && entry.name === 'thonnas-infra.json') {
      files.push(fullPath);
    }
  }
  // Prefer generated/ over root for same component
  const byComponentDir = new Map<string, string>();
  const normalized = (p: string) => p.replace(/\\/g, '/');
  for (const f of files) {
    const dir = path.dirname(f);
    const componentDir = normalized(dir).endsWith('/generated') ? path.dirname(dir) : dir;
    const existing = byComponentDir.get(componentDir);
    const isGenerated = normalized(f).includes('/generated/');
    if (!existing || (isGenerated && !normalized(existing).includes('/generated/'))) {
      byComponentDir.set(componentDir, f);
    }
  }
  return Array.from(byComponentDir.values());
};

// @intent Replace placeholders ({deploy-slug}, {env}, {component}, {rootDomain}); forHost=true uses empty env for prod/production
const substituteTokens = (value: string | undefined, component: string, forHost = false): string | undefined => {
  if (!value) return value;
  const deploySlugPrefix = computeDeploySlugPrefix(ENV, RAW_DEPLOY_SLUG);
  const envValue = forHost ? getEnvForHost(ENV) : ENV;
  return value
    .replaceAll('{deploy-slug}', deploySlugPrefix)
    .replaceAll('{env}', envValue)
    .replaceAll('{component}', component)
    .replaceAll('{rootDomain}', ROOT_DOMAIN);
};

// @intent Resolve tokens inside a single endpoint descriptor.
const materializeEndpoint = (
  endpoint: EndpointDescriptor | undefined,
  component: string,
): EndpointDescriptor | undefined => {
  if (!endpoint) return undefined;
  return {
    ...endpoint,
    host: postProcessHost(substituteTokens(endpoint.host, component, true)),
    url: substituteTokens(endpoint.url, component),
  };
};

const RESERVED_SET_KEYS = new Set(['hostnamePattern', 'default', 'primary', 'endpoints', 'roleKeyed']);

const isEndpointDescriptor = (v: unknown): v is EndpointDescriptor =>
  v != null && typeof v === 'object' && !Array.isArray(v) && ('host' in v || 'port' in v || 'url' in v);

// @intent Materialize set and every role key so {{endpoints.internal.<key>.host}} works for any key in thonnas-infra.
const materializeSet = (set: EndpointSet | undefined, component: string): EndpointSet | undefined => {
  if (!set) return undefined;
  const defaultEp = materializeEndpoint(set.default, component);
  const out: EndpointSet = {
    hostnamePattern: postProcessHost(substituteTokens(set.hostnamePattern, component, true)),
    default: defaultEp,
    primary: defaultEp,
    endpoints:
      set.endpoints
        ?.map((entry) => materializeEndpoint(entry, component))
        .filter((ep): ep is EndpointDescriptor => ep !== undefined) ?? undefined,
  };
  for (const [key, value] of Object.entries(set)) {
    if (RESERVED_SET_KEYS.has(key)) continue;
    if (isEndpointDescriptor(value)) {
      out[key] = materializeEndpoint(value, component);
    }
  }
  return out;
};

// @intent Materialize both internal/external endpoint sets for a component.
const materializeEndpoints = (
  component: string,
  endpoints?: ComponentEndpoints,
): ComponentEndpoints | undefined => {
  if (!endpoints) return undefined;
  return {
    internal: materializeSet(endpoints.internal, component),
    external: materializeSet(endpoints.external, component),
  };
};

// @intent Load and parse thonnas-infra.json for a single component.
const readInfraFile = async (filePath: string): Promise<Record<string, unknown>> => {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
};

// @intent Normalize definition blocks so downstream code can treat them uniformly. Accepts role-keyed endpoint sets (primary, debug, ...) and normalizes to default + endpoints.
const coerceDefinitionBlock = (value: unknown): DefinitionBlock => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const block = value as Record<string, unknown>;
  const rawEndpoints = block.endpoints as Record<string, unknown> | undefined;
  let endpoints: ComponentEndpoints | undefined;
  if (rawEndpoints) {
    endpoints = {
      internal: normalizeEndpointSet(rawEndpoints.internal),
      external: normalizeEndpointSet(rawEndpoints.external),
    };
  }
  return {
    domain: block.domain as string | undefined,
    strategies: block.strategies as Record<string, unknown> | undefined,
    endpoints,
    derivations: block.derivations as DerivationDescriptor[] | undefined,
  };
};

// @intent Convert env overrides (which may just be strategy maps) into DefinitionBlock shape.
const coerceEnvironmentBlock = (value: unknown): DefinitionBlock => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  if (
    (value as Record<string, unknown>).strategies ||
    (value as Record<string, unknown>).endpoints ||
    (value as Record<string, unknown>).derivations ||
    (value as Record<string, unknown>).domain
  ) {
    return coerceDefinitionBlock(value);
  }
  return {
    strategies: value as Record<string, unknown>,
  };
};

// @intent Split raw thonnas-infra JSON into default + environment-specific definitions.
const splitInfra = (component: string, raw: Record<string, unknown>): ParsedInfra => {
  const version = Number(raw.thonnasInfraVersion ?? raw.version ?? 1);
  const defaultBlock =
    raw.default && typeof raw.default === 'object' ? coerceDefinitionBlock(raw.default) : coerceDefinitionBlock(raw);

  const environments: Record<string, DefinitionBlock> = {};

  if (raw.environments && typeof raw.environments === 'object') {
    Object.entries(raw.environments as Record<string, unknown>).forEach(([env, definition]) => {
      environments[env] = coerceEnvironmentBlock(definition);
    });
  }

  Object.entries(raw).forEach(([key, value]) => {
    if (RESERVED_KEYS.has(key)) {
      return;
    }
    environments[key] = coerceEnvironmentBlock(value);
  });

  return {
    key: component,
    version,
    defaultBlock,
    environments,
  };
};

// @intent Deep-merge env overrides onto default so derivations see correct values (e.g. beta overrides only endpoints.external.default.host).
const deepMerge = (base: unknown, override: unknown): unknown => {
  if (override === undefined || override === null) return base;
  if (base === undefined || base === null) return override;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override;
  const result = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[key];
    const overrideVal = (override as Record<string, unknown>)[key];
    (result as Record<string, unknown>)[key] = deepMerge(baseVal, overrideVal) as unknown;
  }
  return result;
};

// @intent For the requested env: if no env block, use default; otherwise deep-merge env onto default so any env value overrides default at every level, then normalize endpoints.
const pickBlockForEnv = (component: ParsedInfra, env: string): DefinitionBlock => {
  const envBlock = component.environments[env];
  if (!envBlock) {
    return component.defaultBlock;
  }
  const merged = deepMerge(component.defaultBlock, envBlock) as DefinitionBlock;
  const rawEndpoints = merged.endpoints as Record<string, unknown> | undefined;
  let endpoints: ComponentEndpoints | undefined;
  if (rawEndpoints) {
    endpoints = {
      internal: normalizeEndpointSet(rawEndpoints.internal),
      external: normalizeEndpointSet(rawEndpoints.external),
    };
  } else {
    endpoints = merged.endpoints;
  }
  return {
    domain: merged.domain,
    strategies: merged.strategies,
    endpoints,
    derivations: merged.derivations ?? component.defaultBlock.derivations,
  };
};

// @intent Safely read dotted paths out of nested objects (used by derivations).
const getValueByPath = (obj: unknown, pointer?: string): unknown => {
  if (!pointer) return undefined;
  return pointer.split('.').reduce((acc, segment) => {
    if (acc === undefined || acc === null) return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, obj);
};

// @intent Fill a template string using Handlebars with thonnas helpers (e.g., {{url endpoints.external.default}})
const renderTemplate = (template: string, context: Record<string, unknown>): string => {
  return hbsRenderTemplate(template, context);
};

// @intent Dynamically import resolver modules referenced by derivations.
const importResolver = async (component: string, relativePath: string) => {
  const absolute = path.resolve(componentsDir, component, relativePath);
  return import(pathToFileURL(absolute).href) as Promise<{ derive: (ctx: ResolverContext) => unknown }>;
};

// @intent Merge generated publishedServices into infra component when generated/thonnas-infra.generated.json exists
const mergeGeneratedPublishedServices = async (
  raw: Record<string, unknown>,
  componentDir: string,
): Promise<void> => {
  const genPath = path.join(componentDir, 'generated', 'thonnas-infra.generated.json');
  try {
    const gen = await fs.readFile(genPath, 'utf8');
    const genJson = JSON.parse(gen) as { publishedServices?: unknown };
    if (!Array.isArray(genJson.publishedServices)) return;
    const def = (raw.default ??= {}) as Record<string, unknown>;
    const strategies = (def.strategies ??= {}) as Record<string, unknown>;
    const composeHost = (strategies.composeHost ??= {}) as Record<string, unknown>;
    const extras = (composeHost.extras ??= {}) as Record<string, unknown>;
    extras.publishedServices = genJson.publishedServices;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
};

// @intent Load thonnas-infra.json for every component under /components.
const loadComponents = async (): Promise<ParsedInfra[]> => {
  const infraFiles = await collectInfraFiles(componentsDir);
  const components: ParsedInfra[] = [];
  for (const filePath of infraFiles) {
    const raw = await readInfraFile(filePath);
    const rel = path.relative(componentsDir, filePath).replace(/\\/g, '/');
    const fileComponentDir = path.dirname(filePath);
    await mergeGeneratedPublishedServices(raw, fileComponentDir);
    let key = rel.replace(/\/thonnas-infra\.json$/, '').replace(/\//g, '__');
    if (key.endsWith('__generated')) key = key.slice(0, -10);
    components.push(splitInfra(key, raw));
  }
  return components;
};

// @intent Write values into nested objects using dot notation (foo.bar.baz = value).
const setDeepValue = (target: Record<string, unknown>, keyPath: string, value: unknown): void => {
  const segments = keyPath.split('.').filter(Boolean);
  if (segments.length === 0) {
    return;
  }
  let current: Record<string, unknown> = target;
  while (segments.length > 1) {
    const segment = segments.shift()!;
    if (!current[segment] || typeof current[segment] !== 'object') {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[0]] = value;
};

// @intent Ensure a map has an entry for the current environment before writing values.
const ensureEnvBlock = (
  target: Record<string, Record<string, unknown>>,
  env: string,
): Record<string, unknown> => {
  if (!target[env]) {
    target[env] = {};
  }
  return target[env];
};

// @intent Ensure a component slice inside an env block so derivations do not overwrite each other (api-nest vs api-nest-thonnas-marketplace).
const ensureComponentBlock = (
  envBlock: Record<string, unknown>,
  componentKey: string,
): Record<string, unknown> => {
  if (!envBlock[componentKey] || typeof envBlock[componentKey] !== 'object') {
    envBlock[componentKey] = {};
  }
  return envBlock[componentKey] as Record<string, unknown>;
};

const main = async (): Promise<void> => {
  ROOT_DOMAIN = await resolveRootDomainForGenerate(ENV, cliEnv.rootDomain, repoRoot);

  // @intent Ensure generated/ exists per Thonnas convention (all generated files under {component}/generated/)
  await fs.mkdir(generatedDir, { recursive: true });

  // Load component infra specs and prepare containers for exports + trees.
  const components = await loadComponents();
  const configExports: ConfigExportMeta[] = [];
  const secretExports: Record<string, unknown>[] = [];
  const configTree: Record<string, Record<string, unknown>> = { default: {} };
  const secretTree: Record<string, Record<string, unknown>> = {};

  const materializedEndpoints = new Map<string, ComponentEndpoints | undefined>();
  /** @intent Enforce one component per export name; throw if duplicate across components */
  const exportNameToComponent = new Map<string, string>();

  // @intent Extract parent component key from module keys (e.g., api-nest__src__modules__tm-user → api-nest)
  const getParentComponentKey = (key: string): string | undefined => {
    const segments = key.split('__');
    if (segments.length > 1) {
      return segments[0]; // Return top-level component key
    }
    return undefined;
  };

  components.forEach((component) => {
    const block = pickBlockForEnv(component, ENV);
    const endpoints = materializeEndpoints(component.key, block.endpoints ?? component.defaultBlock.endpoints);
    materializedEndpoints.set(component.key, endpoints);
  });

  const allComponentsContext = Object.fromEntries(
    Array.from(materializedEndpoints.entries()).map(([key, endpoints]) => [key, { endpoints }]),
  );

  // @intent Get endpoints for a component, inheriting from parent if module doesn't define its own
  const getEndpointsForComponent = (component: ParsedInfra): ComponentEndpoints | undefined => {
    const ownEndpoints = materializedEndpoints.get(component.key);
    if (ownEndpoints) {
      return ownEndpoints;
    }
    // For module-level infra files, inherit endpoints from parent component
    const parentKey = getParentComponentKey(component.key);
    if (parentKey) {
      return materializedEndpoints.get(parentKey);
    }
    return undefined;
  };

  for (const component of components) {
    const activeBlock = pickBlockForEnv(component, ENV);
    const endpoints = getEndpointsForComponent(component);
    const derivations = activeBlock.derivations ?? component.defaultBlock.derivations ?? [];
    if (!endpoints && derivations.length === 0) {
      continue;
    }

    for (const derivation of derivations) {
      if (!derivation.name) continue;

      const context: ResolverContext = {
        component: component.key,
        env: ENV,
        rootDomain: ROOT_DOMAIN,
        endpoints,
        options: derivation.options ?? {},
        allComponents: allComponentsContext,
      };

      let resolved: ResolverResult | undefined;

      if (derivation.resolverModule) {
        const mod = await importResolver(component.key, derivation.resolverModule);
        if (typeof mod.derive !== 'function') {
          throw new Error(
            `Resolver module ${derivation.resolverModule} for ${component.key} must export a "derive" function.`,
          );
        }
        const output = await mod.derive(context);
        if (output && typeof output === 'object' && 'value' in output) {
          resolved = output as ResolverResult;
        } else {
          resolved = { value: output };
        }
      } else {
        let value: unknown;
        if (derivation.sourcePath) {
          value = getValueByPath({ endpoints }, derivation.sourcePath);
        } else if (derivation.source) {
          value = renderTemplate(derivation.source, { ...context, endpoints });
        } else {
          value = endpoints;
        }
        resolved = { value };
      }

      if (!resolved || resolved.value === undefined) {
        continue;
      }

      const targetType = resolved.type ?? derivation.type ?? 'config';
      const resolvedFormat =
        resolved.format ?? derivation.templateType ?? (typeof resolved.value === 'object' ? 'json' : 'string');
      const serializedValue =
        resolvedFormat === 'json'
          ? typeof resolved.value === 'string'
            ? resolved.value
            : JSON.stringify(resolved.value)
          : typeof resolved.value === 'string'
            ? resolved.value
            : String(resolved.value);

      if (targetType === 'secret') {
        secretExports.push({
          name: derivation.name,
          sourceType: resolved.secretSourceType ?? derivation.secretSourceType ?? 'generated',
          description: resolved.description ?? derivation.description,
          selfImportPath: resolved.path ?? derivation.path,
          default: serializedValue,
        });
        const envBlock = ensureEnvBlock(secretTree, ENV);
        setDeepValue(envBlock, derivation.path ?? resolved.path ?? derivation.name, serializedValue);
      } else {
        const envBlock = ensureEnvBlock(configTree, ENV);
        const componentBlock = ensureComponentBlock(envBlock as Record<string, unknown>, component.key);
        let valueForTree: unknown = serializedValue;
        if (resolvedFormat === 'json') {
          if (typeof resolved.value === 'string') {
            try {
              valueForTree = JSON.parse(resolved.value);
            } catch {
              valueForTree = resolved.value;
            }
          } else {
            valueForTree = resolved.value;
          }
        }
        setDeepValue(componentBlock, derivation.path ?? resolved.path ?? derivation.name, valueForTree);
        const existingDerivation = exportNameToComponent.get(derivation.name);
        if (existingDerivation !== undefined && existingDerivation !== component.key) {
          throw new Error(
            `Duplicate export "${derivation.name}": already exported by "${existingDerivation}", cannot also export from "${component.key}". Each export name must be unique across components.`,
          );
        }
        exportNameToComponent.set(derivation.name, component.key);
        configExports.push({
          name: derivation.name,
          description: resolved.description ?? derivation.description,
          selfImportPath: resolved.path ?? derivation.path,
          default: valueForTree,
          format: resolvedFormat,
          componentKey: component.key,
        });
      }
    }
  }

  // @intent Seed config tree from components' thonnas-config.json exports with provider "infra"; enforce one component per export name
  for (const component of components) {
    const componentDir = path.join(componentsDir, ...component.key.split('__'));
    const configPath = path.join(componentDir, 'thonnas-config.json');
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw) as { exports?: Array<{ name: string; provider?: string; selfImportPath?: string; default?: unknown; format?: string }> };
      const exports = cfg.exports ?? [];
      for (const exp of exports) {
        if (exp.provider !== 'infra') continue;
        const existing = exportNameToComponent.get(exp.name);
        if (existing !== undefined) {
          if (existing !== component.key) {
            throw new Error(
              `Duplicate export "${exp.name}": already exported by "${existing}", cannot also export from "${component.key}". Each export name must be unique across components.`,
            );
          }
          continue;
        }
        exportNameToComponent.set(exp.name, component.key);
        const envBlock = ensureEnvBlock(configTree, ENV);
        const componentBlock = ensureComponentBlock(envBlock as Record<string, unknown>, component.key);
        const pathToSet = exp.selfImportPath ?? exp.name;
        const value = exp.default !== undefined && exp.default !== null ? exp.default : undefined;
        if (value !== undefined) {
          setDeepValue(componentBlock, pathToSet, value);
        }
        configExports.push({
          name: exp.name,
          selfImportPath: exp.selfImportPath,
          default: exp.default,
          format: (exp.format as 'string' | 'json') ?? 'string',
          componentKey: component.key,
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  const sortedConfig = configExports.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const config = {
    config: configTree,
    imports: [],
    exports: sortedConfig,
  };
  await fs.writeFile(configOutputFile, JSON.stringify(config, null, 2));
  console.log(`Generated config exports at ${path.relative(componentDir, configOutputFile)}`);

  if (secretExports.length > 0) {
    const sortedSecrets = secretExports.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const secrets = {
      config: secretTree,
      imports: [],
      exports: sortedSecrets,
    };
    await fs.writeFile(secretsOutputFile, JSON.stringify(secrets, null, 2));
    console.log(`Generated secret exports at ${path.relative(componentDir, secretsOutputFile)}`);
  } else {
    try {
      await fs.rm(secretsOutputFile);
    } catch {
      // ignore missing file
    }
  }
};

main().catch((error) => {
  console.error('[generate-endpoints] Failed:', error);
  process.exit(1);
});
