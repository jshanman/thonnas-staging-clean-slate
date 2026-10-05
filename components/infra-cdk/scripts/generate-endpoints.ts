#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Handlebars from 'handlebars';

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
  endpoints?: EndpointDescriptor[] | Record<string, EndpointDescriptor | EndpointDescriptor[]>;
}

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

interface ResolverResult {
  value: unknown;
  path?: string;
  description?: string;
  type?: 'config' | 'secret';
  format?: 'string' | 'json';
  secretSourceType?: 'generated' | 'user-provided';
}

type ExportMeta = {
  name: string;
  description?: string;
  selfImportPath?: string;
  format?: 'string' | 'json';
  default?: unknown;
};

type SecretExportMeta = ExportMeta & {
  sourceType: 'generated' | 'user-provided';
  generator?: NonNullable<ResolverResult['secretSourceType']>;
};

const DEFAULT_ENVIRONMENTS = (process.env.THONNAS_ENVIRONMENTS ?? 'beta,staging,production')
  .split(',')
  .map((env) => env.trim())
  .filter(Boolean);

// @intent For prod/production, omit env and deploy-slug from hostnames so e.g. {deploy-slug}.{env}.api.{rootDomain} → api.{rootDomain}
const getEnvForHost = (env: string): string => {
  const lower = env.toLowerCase();
  return lower === 'prod' || lower === 'production' ? '' : env;
};

// @intent Compute value for {deploy-slug} placeholder (CLI pre-validates slug; omit in prod and when empty or equals env)
const computeDeploySlugPrefix = (env: string, deploySlug: string | null | undefined): string => {
  const lowerEnv = env.toLowerCase();
  if (lowerEnv === 'prod' || lowerEnv === 'production') return '';
  if (!deploySlug || !deploySlug.trim()) return '';
  const s = deploySlug.trim().toLowerCase();
  if (s === lowerEnv) return '';
  return s;
};

// @intent After token replacement: strip leading period and collapse multiple periods to one
const postProcessHost = (value: string | undefined): string | undefined => {
  if (value == null || value === '') return value;
  return value.replace(/^\.+/, '').replace(/\.\.+/g, '.');
};

function isDirectoryOrSymlinkToDir(stat: { isDirectory: () => boolean }): boolean {
  return stat.isDirectory();
}

// @intent Parse optional --deploy-slug (same semantics as Thonnas CLI config resolve / infra)
function parseCliOptions(argv: string[]): { deploySlug: string | null } {
  let deploySlug: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--deploy-slug' && argv[i + 1]) {
      deploySlug = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--deploy-slug=')) {
      deploySlug = arg.slice('--deploy-slug='.length);
    }
  }
  return { deploySlug };
}

const cli = parseCliOptions(process.argv.slice(2));
const RAW_DEPLOY_SLUG = cli.deploySlug ?? process.env.THONNAS_DEPLOY_SLUG ?? null;

// @intent Recursively collect all thonnas-infra.json files under /components (components + modules). Treats symlinks to dirs as dirs.
const collectInfraFiles = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let stat: { isDirectory: () => boolean; isFile: () => boolean };
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (isDirectoryOrSymlinkToDir(stat)) {
      if (entry.name === 'node_modules') continue;
      const nested = await collectInfraFiles(fullPath);
      files.push(...nested);
    } else if (stat.isFile() && entry.name === 'thonnas-infra.json') {
      files.push(fullPath);
    }
  }
  return files;
};

// @intent Respect project/repo root from CLI/config-thonnas when set; else discover from cwd (npm run from components/infra-cdk)
function resolveRepoAndComponentDir(): { repoRoot: string; componentDir: string } {
  const fromEnv = process.env.THONNAS_ROOT ?? process.env.THONNAS_REPO_ROOT;
  if (fromEnv?.trim()) {
    const repoRoot = path.resolve(fromEnv.trim());
    return { repoRoot, componentDir: path.join(repoRoot, 'components', 'infra-cdk') };
  }
  const cwd = process.cwd();
  const dirName = path.basename(cwd);
  const parentName = path.basename(path.dirname(cwd));
  if (dirName === 'infra-cdk' && parentName === 'components') {
    return { repoRoot: path.resolve(cwd, '..', '..'), componentDir: cwd };
  }
  return { repoRoot: cwd, componentDir: path.join(cwd, 'components', 'infra-cdk') };
}

const { repoRoot, componentDir } = resolveRepoAndComponentDir();
const componentsDir = path.join(repoRoot, 'components');
const generatedDir = path.join(componentDir, 'generated');
const configOutputFile = path.join(generatedDir, 'thonnas-config.generated.json');
const secretsOutputFile = path.join(generatedDir, 'thonnas-secrets.generated.json');

let cachedRootDomain: string | undefined;

// @intent Read optional rootDomain hint from repo-level thonnas-package.json.
const readRootDomainFromPackage = async (): Promise<string | undefined> => {
  if (cachedRootDomain !== undefined) {
    return cachedRootDomain;
  }
  try {
    const pkgPath = path.join(repoRoot, 'thonnas-package.json');
    const raw = await fs.readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { thonnas?: { root_domain?: string } };
    cachedRootDomain = parsed.thonnas?.root_domain?.trim() || undefined;
  } catch {
    cachedRootDomain = undefined;
  }
  return cachedRootDomain;
};

// @intent Resolve effective root domain per environment using env overrides or repo defaults.
const resolveRootDomain = async (env: string): Promise<string> => {
  const envOverride =
    process.env[`THONNAS_ROOT_DOMAIN_${env.toUpperCase()}`] ??
    process.env[`THONNAS_${env.toUpperCase()}_ROOT_DOMAIN`];
  if (envOverride?.trim()) {
    return envOverride.trim();
  }
  const shared = process.env.THONNAS_ROOT_DOMAIN?.trim();
  if (shared) {
    return shared;
  }
  const fromPackage = await readRootDomainFromPackage();
  if (fromPackage) {
    return fromPackage;
  }
  return 'example.local';
};

// @intent Replace {env}/{component}/{rootDomain} placeholders; forHost=true uses empty env for prod/production
const substituteTokens = (
  value: string | undefined,
  component: string,
  env: string,
  rootDomain: string,
  forHost = false,
): string | undefined => {
  if (!value) {
    return value;
  }
  const deploySlugPrefix = computeDeploySlugPrefix(env, RAW_DEPLOY_SLUG);
  const envValue = forHost ? getEnvForHost(env) : env;
  return value
    .replaceAll('{deploy-slug}', deploySlugPrefix)
    .replaceAll('{env}', envValue)
    .replaceAll('{component}', component)
    .replaceAll('{rootDomain}', rootDomain);
};

// @intent Apply postProcessHost only to hostname-like fields (host, hostnamePattern), not url
const substituteTokensForHost = (
  value: string | undefined,
  component: string,
  env: string,
  rootDomain: string,
): string | undefined => postProcessHost(substituteTokens(value, component, env, rootDomain, true));

// @intent Produce DNS-safe host labels for fallback hostnames.
const sanitizeHostSegment = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

// @intent Identify beta/beta-feat envs to prefer HTTP/80 fallback.
const isBetaLikeEnv = (env: string): boolean => {
  const lower = env.toLowerCase();
  return lower === 'beta' || lower.startsWith('beta-feat');
};

// @intent Create a mutable clone of endpoint definitions so we can inject fallbacks.
const cloneEndpoints = (endpoints?: ComponentEndpoints): ComponentEndpoints | undefined => {
  if (!endpoints) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(endpoints)) as ComponentEndpoints;
};

const ROLE_KEYS = new Set(['primary', 'debug', 'secondary', 'default']);

// @intent Normalize endpoint set so endpoints is always an array (supports legacy array and role-keyed map).
const normalizeEndpointSet = (set: EndpointSet | undefined): EndpointSet | undefined => {
  if (!set) {
    return undefined;
  }
  const eps = set.endpoints;
  let arr: EndpointDescriptor[];
  let defaultEp: EndpointDescriptor | undefined = set.default;

  if (Array.isArray(eps)) {
    arr = eps;
    if (defaultEp === undefined && arr.length > 0) {
      defaultEp = arr[0];
    }
  } else if (eps && typeof eps === 'object' && !Array.isArray(eps)) {
    // Role-keyed map: { primary: {...}, debug: {...} } or { primary: [...], ... }
    arr = [];
    const primaryOrFirst = (eps as Record<string, unknown>)['primary'] ?? (eps as Record<string, unknown>)['default'];
    for (const v of Object.values(eps)) {
      if (Array.isArray(v)) {
        arr.push(...v);
      } else if (v && typeof v === 'object' && 'host' in (v as object)) {
        arr.push(v as EndpointDescriptor);
      }
    }
    if (defaultEp === undefined && primaryOrFirst !== undefined) {
      defaultEp = Array.isArray(primaryOrFirst)
        ? (primaryOrFirst[0] as EndpointDescriptor)
        : (primaryOrFirst as EndpointDescriptor);
    }
    if (defaultEp === undefined && arr.length > 0) {
      defaultEp = arr[0];
    }
  } else {
    // No endpoints key; collect from top-level role keys (primary, debug, secondary)
    arr = [];
    const raw = set as Record<string, unknown>;
    for (const key of ROLE_KEYS) {
      const v = raw[key];
      if (Array.isArray(v)) {
        arr.push(...(v as EndpointDescriptor[]));
      } else if (v && typeof v === 'object' && 'host' in (v as object)) {
        arr.push(v as EndpointDescriptor);
      }
    }
    if (defaultEp === undefined && raw.primary) {
      defaultEp = Array.isArray(raw.primary) ? (raw.primary[0] as EndpointDescriptor) : (raw.primary as EndpointDescriptor);
    }
    if (defaultEp === undefined && arr.length > 0) {
      defaultEp = arr[0];
    }
  }

  return {
    ...set,
    endpoints: arr,
    default: defaultEp,
  };
};

// @intent Apply token substitution to a single endpoint descriptor.
const materializeEndpoint = (
  endpoint: EndpointDescriptor | undefined,
  component: string,
  env: string,
  rootDomain: string,
): EndpointDescriptor | undefined => {
  if (!endpoint) {
    return undefined;
  }
  return {
    ...endpoint,
    host: substituteTokensForHost(endpoint.host, component, env, rootDomain),
    url: substituteTokens(endpoint.url, component, env, rootDomain),
  };
};

const ENDPOINT_SET_RESERVED_KEYS = new Set(['hostnamePattern', 'default', 'endpoints']);

// @intent Apply token substitution for hostnamePattern/default/endpoints sets. Normalizes role-map to array before mapping.
// Also preserves+materializes any other named endpoint sub-object (e.g. "websocket" in a
// { primary: {...}, websocket: {...} } role map) so templates like
// {{endpoints.external.websocket.port}} keep resolving -- normalizeEndpointSet's ROLE_KEYS only
// covers primary/debug/secondary/default for the flattened `endpoints` array/`default` fallback,
// but any additional tagged key must still survive onto the materialized object by name.
const materializeSet = (
  set: EndpointSet | undefined,
  component: string,
  env: string,
  rootDomain: string,
): EndpointSet | undefined => {
  if (!set) {
    return undefined;
  }
  const normalized = normalizeEndpointSet(set);
  if (!normalized) {
    return undefined;
  }
  const endpointsArr = Array.isArray(normalized.endpoints) ? normalized.endpoints : [];
  const result: EndpointSet & Record<string, unknown> = {
    hostnamePattern: substituteTokensForHost(normalized.hostnamePattern, component, env, rootDomain),
    default: materializeEndpoint(normalized.default, component, env, rootDomain),
    endpoints: endpointsArr.map((entry) => materializeEndpoint(entry, component, env, rootDomain)),
  };
  for (const [key, value] of Object.entries(set as Record<string, unknown>)) {
    if (ENDPOINT_SET_RESERVED_KEYS.has(key)) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && 'host' in (value as object)) {
      result[key] = materializeEndpoint(value as EndpointDescriptor, component, env, rootDomain);
    }
  }
  return result;
};

// @intent Ensure every component exposes at least one external endpoint per env.
const applyExternalFallback = (
  component: string,
  env: string,
  rootDomain: string,
  endpoints: ComponentEndpoints,
): void => {
  if (!endpoints.external) {
    endpoints.external = {};
  }
  if (!endpoints.external.hostnamePattern) {
    endpoints.external.hostnamePattern = '{env}.{component}.{rootDomain}';
  }
  if (!endpoints.external.endpoints || endpoints.external.endpoints.length === 0) {
    const host = substituteTokensForHost(endpoints.external.hostnamePattern, component, env, rootDomain);
    const betaLike = isBetaLikeEnv(env);
    endpoints.external.endpoints = [
      {
        host: host ?? `${sanitizeHostSegment(env)}.${sanitizeHostSegment(component)}.${rootDomain}`,
        port: betaLike ? 80 : 443,
        protocol: betaLike ? 'http' : 'https',
        role: 'primary',
      },
    ];
  }
  if (!endpoints.external.default && endpoints.external.endpoints.length > 0) {
    endpoints.external.default = { ...endpoints.external.endpoints[0] };
  }
};

// @intent Build a fully materialized endpoints block with fallbacks for a component/env pair.
const materializeEndpointsBlock = (
  component: string,
  endpoints: ComponentEndpoints | undefined,
  env: string,
  rootDomain: string,
): ComponentEndpoints | undefined => {
  if (!endpoints) {
    return undefined;
  }
  // Normalize role-map form to array so applyExternalFallback and materializeSet see arrays.
  if (endpoints.internal) {
    endpoints.internal = normalizeEndpointSet(endpoints.internal) ?? endpoints.internal;
  }
  if (endpoints.external) {
    endpoints.external = normalizeEndpointSet(endpoints.external) ?? endpoints.external;
  }
  const hasExternal = Boolean(endpoints.external);
  if (hasExternal && endpoints.external) {
    applyExternalFallback(component, env, rootDomain, endpoints);
  }
  const internal = materializeSet(endpoints.internal, component, env, rootDomain);
  const external = hasExternal && endpoints.external
    ? materializeSet(endpoints.external, component, env, rootDomain)
    : undefined;
  const result: ComponentEndpoints = {};
  if (internal) {
    result.internal = internal;
  }
  if (external) {
    result.external = external;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

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

// @intent Merge generated publishedServices into infra when generated/thonnas-infra.generated.json exists
const mergeGeneratedPublishedServices = async (
  raw: Record<string, unknown>,
  infraDir: string,
): Promise<void> => {
  const genPath = path.join(infraDir, 'generated', 'thonnas-infra.generated.json');
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

// @intent Read a component's thonnas-infra.json when present.
const readInfraFile = async (filePath: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

// @intent Normalize unknown JSON values into DefinitionBlock shape.
const coerceDefinitionBlock = (value: unknown): DefinitionBlock => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const block = value as Record<string, unknown>;
  return {
    domain: block.domain as string | undefined,
    strategies: block.strategies as Record<string, unknown> | undefined,
    endpoints: block.endpoints as ComponentEndpoints | undefined,
    derivations: block.derivations as DerivationDescriptor[] | undefined,
  };
};

// @intent Support legacy env override objects and treat plain records as strategy overrides.
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

// @intent Keep environments.* signals when a top-level env key only overrides strategies
const mergeDefinitionBlocks = (base: DefinitionBlock, overlay: DefinitionBlock): DefinitionBlock => ({
  domain: overlay.domain ?? base.domain,
  strategies: overlay.strategies ?? base.strategies,
  endpoints: overlay.endpoints ?? base.endpoints,
  derivations: overlay.derivations ?? base.derivations,
});

// @intent Split infra specs into default + per-environment definition blocks.
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
    const fromTop = coerceEnvironmentBlock(value);
    const existing = environments[key];
    environments[key] = existing ? mergeDefinitionBlocks(existing, fromTop) : fromTop;
  });

  return {
    key: component,
    version,
    defaultBlock,
    environments,
  };
};

// @intent Merge env overrides with defaults for a specific environment.
const selectBlockForEnv = (component: ParsedInfra, env: string): DefinitionBlock => {
  const envBlock = component.environments[env];
  if (!envBlock) {
    return component.defaultBlock;
  }
  return {
    domain: envBlock.domain ?? component.defaultBlock.domain,
    strategies: envBlock.strategies ?? component.defaultBlock.strategies,
    endpoints: envBlock.endpoints ?? component.defaultBlock.endpoints,
    derivations: envBlock.derivations ?? component.defaultBlock.derivations,
  };
};

// @intent Dynamically import a resolver module relative to its component directory.
const importResolver = async (component: string, resolverPath: string) => {
  const absolute = path.resolve(componentsDir, component, resolverPath);
  return import(pathToFileURL(absolute).href);
};

// @intent Scope connection.internal.*/connection.external.* by component so multiple components do
// not overwrite the same key in infra config -- e.g. queue-mqtt and web-angular both derive an
// "external.host" from their own thonnas-infra.json endpoints; without scoping, both write the
// literal path "connection.external.host" and whichever component's loop iteration ran last wins,
// silently clobbering the other's value (confirmed: this left QUEUE_MQTT_EXTERNAL_HOST resolving
// empty in staging because web-angular's own external derivation ran after queue-mqtt's).
const scopeConnectionPath = (keyPath: string, componentKey: string): string => {
  if (keyPath.startsWith('connection.internal.')) {
    return `connection.${componentKey}.internal.${keyPath.slice('connection.internal.'.length)}`;
  }
  if (keyPath === 'connection.internal') {
    return `connection.${componentKey}.internal`;
  }
  if (keyPath.startsWith('connection.external.')) {
    return `connection.${componentKey}.external.${keyPath.slice('connection.external.'.length)}`;
  }
  if (keyPath === 'connection.external') {
    return `connection.${componentKey}.external`;
  }
  return keyPath;
};

// @intent Write dotted paths (a.b.c) into nested objects for config/secret trees.
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

// @intent Ensure the env-scoped config/secret tree exists before assigning values.
const ensureEnvBlock = (
  target: Record<string, Record<string, unknown>>,
  env: string,
): Record<string, unknown> => {
  if (!target[env]) {
    target[env] = {};
  }
  return target[env];
};

// @intent Load every component's thonnas-infra.json and materialize derivations for each env.
const main = async () => {
  const envs = DEFAULT_ENVIRONMENTS.length > 0 ? DEFAULT_ENVIRONMENTS : ['beta', 'staging', 'production'];
  const infraFiles = await collectInfraFiles(componentsDir);
  const components: ParsedInfra[] = [];
  for (const filePath of infraFiles) {
    const raw = await readInfraFile(filePath);
    if (!raw) continue;
    const infraDir = path.dirname(filePath);
    await mergeGeneratedPublishedServices(raw, infraDir);
    const rel = path.relative(componentsDir, filePath).replace(/\\/g, '/');
    const key = rel.replace(/\/thonnas-infra\.json$/, '').replace(/\//g, '__');
    components.push(splitInfra(key, raw));
  }

  const configExports = new Map<string, ExportMeta>();
  const secretExports = new Map<string, SecretExportMeta>();
  const configTree: Record<string, Record<string, unknown>> = {};
  const secretTree: Record<string, Record<string, unknown>> = {};

  // @intent Extract parent component key from module keys (e.g. api__src__modules__users → api)
  const getParentComponentKey = (key: string): string | undefined => {
    const segments = key.split('__');
    if (segments.length > 1) {
      return segments[0]; // Return top-level component key
    }
    return undefined;
  };

  for (const env of envs) {
    const rootDomain = await resolveRootDomain(env);
    const envEndpoints = new Map<string, ComponentEndpoints | undefined>();
    components.forEach((component) => {
      const block = selectBlockForEnv(component, env);
      const hydrated = cloneEndpoints(block.endpoints ?? component.defaultBlock.endpoints);
      const materialized = materializeEndpointsBlock(component.key, hydrated, env, rootDomain);
      envEndpoints.set(component.key, materialized);
    });
    const allComponentsContext = Object.fromEntries(
      Array.from(envEndpoints.entries()).map(([key, endpoints]) => [key, { endpoints }]),
    );

    // @intent Get endpoints for a component, inheriting from parent if module doesn't define its own
    const getEndpointsForComponent = (componentKey: string): ComponentEndpoints | undefined => {
      const ownEndpoints = envEndpoints.get(componentKey);
      if (ownEndpoints) {
        return ownEndpoints;
      }
      // For module-level infra files, inherit endpoints from parent component
      const parentKey = getParentComponentKey(componentKey);
      if (parentKey) {
        return envEndpoints.get(parentKey);
      }
      return undefined;
    };

    for (const component of components) {
      const block = selectBlockForEnv(component, env);
      const endpoints = getEndpointsForComponent(component.key);
      const derivations = block.derivations ?? component.defaultBlock.derivations ?? [];
      if (!endpoints && derivations.length === 0) {
        continue;
      }
      for (const derivation of derivations) {
        if (!derivation.name) {
          continue;
        }
        const context = {
          component: component.key,
          env,
          rootDomain,
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
          resolved =
            output && typeof output === 'object' && 'value' in output
              ? (output as ResolverResult)
              : { value: output };
        } else {
          let value: unknown;
          if (derivation.sourcePath) {
            value = (endpoints as Record<string, unknown> | undefined)
              ? derivation.sourcePath.split('.').reduce((acc: any, key) => acc?.[key], { endpoints })
              : undefined;
          } else if (derivation.source) {
            // Use Handlebars-based template rendering with helpers (e.g., {{url endpoints.external.default}})
            value = hbsRenderTemplate(derivation.source, {
              env,
              component: component.key,
              rootDomain,
              endpoints,
              options: derivation.options ?? {},
            });
          } else {
            value = endpoints;
          }
          resolved = { value };
        }
        if (!resolved || resolved.value === undefined) {
          continue;
        }
        const targetType = resolved.type ?? derivation.type ?? 'config';
        const rawPath = derivation.path ?? resolved.path;
        if (!rawPath) {
          continue;
        }
        const outputPath = scopeConnectionPath(rawPath, component.key);
        const resolvedFormat: 'json' | 'string' =
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
          const envBlock = ensureEnvBlock(secretTree, env);
          setDeepValue(envBlock, outputPath, serializedValue);
          if (!secretExports.has(derivation.name)) {
            secretExports.set(derivation.name, {
              name: derivation.name,
              description: resolved.description ?? derivation.description,
              selfImportPath: outputPath,
              sourceType: resolved.secretSourceType ?? derivation.secretSourceType ?? 'generated',
            });
          }
        } else {
          const envBlock = ensureEnvBlock(configTree, env);
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
          setDeepValue(envBlock, outputPath, valueForTree);
          if (!configExports.has(derivation.name)) {
            configExports.set(derivation.name, {
              name: derivation.name,
              description: resolved.description ?? derivation.description,
              selfImportPath: outputPath,
              format: resolvedFormat,
            });
          }
        }
      }
    }
  }

  if (!configTree.default) {
    configTree.default = {};
  }
  if (Object.keys(secretTree).length > 0 && !secretTree.default) {
    secretTree.default = {};
  }

  const configPayload = {
    config: configTree,
    imports: [],
    exports: Array.from(configExports.values()).sort((a, b) => a.name.localeCompare(b.name)),
  };
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.writeFile(configOutputFile, JSON.stringify(configPayload, null, 2));
  console.log(`Generated config exports at ${path.relative(componentDir, configOutputFile)}`);

  if (secretExports.size > 0) {
    const secretsPayload = {
      config: secretTree,
      imports: [],
      exports: Array.from(secretExports.values()).sort((a, b) => a.name.localeCompare(b.name)),
    };
    await fs.writeFile(secretsOutputFile, JSON.stringify(secretsPayload, null, 2));
    console.log(`Generated secret exports at ${path.relative(componentDir, secretsOutputFile)}`);
  } else {
    try {
      await fs.rm(secretsOutputFile);
    } catch {
      // ignore missing secrets file
    }
  }
};

main().catch((error) => {
  console.error('[generate-endpoints] Failed:', error);
  process.exit(1);
});




