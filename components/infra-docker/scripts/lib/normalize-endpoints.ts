// @intent Normalize endpoint set from role-keyed object (endpoints: { primary, debug, ... }) to default + endpoints array for consumers. hostnamePattern passed through or derived from primary.host.

export interface EndpointDescriptor {
  host?: string;
  port?: number;
  protocol?: string;
  role?: string;
  tags?: string[];
  url?: string;
}

export interface NormalizedEndpointSet {
  default?: EndpointDescriptor;
  endpoints?: EndpointDescriptor[];
  hostnamePattern?: string;
  /** Role-keyed map so templates can use {{endpoints.internal.primary.host}}, {{endpoints.internal.dashboard.host}}, etc. without hardcoding. */
  roleKeyed?: Record<string, EndpointDescriptor>;
}

function toDescriptor(v: unknown): EndpointDescriptor | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    host: typeof o.host === 'string' ? o.host : undefined,
    port: typeof o.port === 'number' ? o.port : undefined,
    protocol: typeof o.protocol === 'string' ? o.protocol : undefined,
    role: typeof o.role === 'string' ? o.role : undefined,
    tags: Array.isArray(o.tags) ? (o.tags as string[]) : undefined,
    url: typeof o.url === 'string' ? o.url : undefined,
  };
}

function toList(v: unknown): EndpointDescriptor[] {
  if (Array.isArray(v)) return v.map(toDescriptor).filter(Boolean) as EndpointDescriptor[];
  const d = toDescriptor(v);
  return d ? [d] : [];
}

const ROLE_ORDER = ['primary', 'debug', 'collector', 'dashboard', 'secondary'];

/** @intent Normalize endpoint set from role-keyed object to default + endpoints array so templates like {{endpoints.external.default.host}} work.
 * Accepts either { endpoints: { primary, debug, ... } } or { primary, debug, ... } (role keys at top level, as in thonnas-infra.json). */
export function normalizeEndpointSet(raw: unknown): NormalizedEndpointSet | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;

  let rawEndpoints: unknown = obj.endpoints;
  if (
    rawEndpoints === undefined ||
    rawEndpoints === null ||
    typeof rawEndpoints !== 'object' ||
    Array.isArray(rawEndpoints)
  ) {
    // Role keys at top level (e.g. internal: { primary: {...}, websocket: {...} })
    if (obj.primary !== undefined || obj.default !== undefined || obj.debug !== undefined) {
      rawEndpoints = obj;
    } else {
      return undefined;
    }
  }

  const roleMap = rawEndpoints as Record<string, unknown>;
  const all: EndpointDescriptor[] = [];
  const roleKeyed: Record<string, EndpointDescriptor> = {};
  let primary: EndpointDescriptor | undefined;
  const keys = [...new Set([...ROLE_ORDER, ...Object.keys(roleMap)])];

  for (const k of keys) {
    const v = roleMap[k];
    if (v === undefined) continue;
    const list = toList(v);
    const first = list[0];
    if (first) {
      if (!first.role) first.role = k;
      roleKeyed[k] = first;
    }
    for (const ep of list) {
      if (!ep.role) ep.role = k;
      all.push(ep);
      if (k === 'primary' && !primary) primary = first ?? ep;
    }
    if (k === 'primary' && first && !primary) primary = first;
  }
  if (!primary && all.length > 0) primary = all[0];

  return {
    hostnamePattern: typeof obj.hostnamePattern === 'string' ? obj.hostnamePattern : undefined,
    default: primary,
    endpoints: all.length > 0 ? all : undefined,
    roleKeyed: Object.keys(roleKeyed).length > 0 ? roleKeyed : undefined,
  };
}

/** @intent Merge top-level env-sibling blocks (e.g. "beta": {...}, a sibling of "default") into
 * `environments[env]`, matching infra-cdk's deployment-intents.ts collector so both systems read the
 * same thonnas-infra.json the same way. When a component declares the same env both as a top-level
 * sibling AND nested under `environments` (e.g. to layer extra derivations on), merge
 * strategies/endpoints/derivations rather than letting one silently discard the other. */
function mergeTopLevelEnvsIntoEnvironments(raw: Record<string, unknown>): Record<string, unknown> {
  const { thonnasInfraVersion, default: defaultBlock, environments, ...topLevelEnvs } = raw;
  const nestedEnvs = (environments as Record<string, Record<string, unknown>> | undefined) ?? {};
  const envNames = new Set([...Object.keys(topLevelEnvs), ...Object.keys(nestedEnvs)]);
  const mergeSubField = <T>(
    a: T | undefined,
    b: T | undefined,
    combine: (a: T, b: T) => T,
  ): T | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return combine(a, b);
  };
  const mergedEnvironments: Record<string, unknown> = {};
  for (const envName of envNames) {
    const fromTopLevel = topLevelEnvs[envName] as Record<string, unknown> | undefined;
    const fromNested = nestedEnvs[envName];
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
    mergedEnvironments[envName] = merged;
  }
  return { thonnasInfraVersion, default: defaultBlock, environments: mergedEnvironments };
}

/** @intent Normalize all endpoint sets in a component infra (default and each environment) so consumers see default + endpoints array. */
export function normalizeComponentInfra(raw: Record<string, unknown>): Record<string, unknown> {
  const out = mergeTopLevelEnvsIntoEnvironments(JSON.parse(JSON.stringify(raw)) as Record<string, unknown>);

  const normalizeBlock = (block: Record<string, unknown> | undefined) => {
    if (!block?.endpoints || typeof block.endpoints !== 'object') return;
    const ep = block.endpoints as Record<string, unknown>;
    if (ep.internal !== undefined) {
      const n = normalizeEndpointSet(ep.internal);
      ep.internal = n ?? ep.internal;
    }
    if (ep.external !== undefined) {
      const n = normalizeEndpointSet(ep.external);
      ep.external = n ?? ep.external;
    }
  };

  const def = out.default as Record<string, unknown> | undefined;
  if (def) normalizeBlock(def);

  const envs = out.environments as Record<string, Record<string, unknown>> | undefined;
  if (envs && typeof envs === 'object') {
    for (const env of Object.values(envs)) {
      if (env && typeof env === 'object') normalizeBlock(env);
    }
  }

  return out;
}


