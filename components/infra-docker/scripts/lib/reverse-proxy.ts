// @intent Extract reverse-proxy generation logic for testability; used by e2e-build

export interface DiscoveryEntry {
  componentKey: string;
  /** componentKey::alias, or bare componentKey when unaliased -- matches thonnas-cli's own identity. */
  instanceKey?: string;
  composePath: string;
  relativePath: string;
}

/**
 * FEAT-011: resolve the alias-safe upstream host via the graph-provided map, falling back to the
 * entry's own declared host when there's no instanceKey/map entry (keeps existing callers/tests
 * that don't pass a map working unchanged).
 */
function resolveUpstreamHost(
  entry: DiscoveryEntry,
  declaredHost: string,
  serviceNameByInstanceKey?: Map<string, string>,
): string {
  if (!serviceNameByInstanceKey || !entry.instanceKey) return declaredHost;
  return serviceNameByInstanceKey.get(entry.instanceKey) ?? declaredHost;
}

export interface DerivationDescriptor {
  name: string;
  source?: string;
  sourcePath?: string;
}

export interface EndpointDescriptor {
  host?: string;
  port?: number;
  protocol?: string;
  tags?: string[];
}

export interface EndpointSet {
  default?: EndpointDescriptor;
  endpoints?: EndpointDescriptor[];
  /** Role-keyed endpoints from normalized infra (primary, dashboard, etc.); used for multiple routes per component. */
  roleKeyed?: Record<string, EndpointDescriptor>;
}

export interface ComponentInfra {
  default?: {
    derivations?: DerivationDescriptor[];
    endpoints?: { internal?: EndpointSet; external?: EndpointSet };
  };
  environments?: Record<string, { endpoints?: { external?: EndpointSet } }>;
}

export interface ReverseProxyRoute {
  envVar: string;
  upstream: string;
  websocket: boolean;
  /** Default host from component infra (environments[env].endpoints.external.default.host) */
  defaultHost?: string;
  /** Component key (e.g. api-nest) for hostname pattern resolution */
  componentKey: string;
}

/** @intent Extract external default host from infra for given env */
function getExternalDefaultHost(infra: ComponentInfra | undefined, env: string): string | undefined {
  if (!infra) return undefined;
  const envBlock = infra.environments?.[env]?.endpoints?.external;
  const defaultBlock = infra.default?.endpoints?.external;
  const ext = envBlock ?? defaultBlock;
  const defaultEp = ext?.default ?? ext?.endpoints?.[0];
  return defaultEp?.host;
}

/** @intent Return true when host is a template (e.g. {env}.growthbook.{rootDomain}) that must be resolved per env. */
function isTemplateHost(host: string | undefined): boolean {
  return (
    typeof host === 'string' &&
    (host.includes('{env}') || host.includes('{rootDomain}'))
  );
}

/** @intent Only HTTP/WebSocket endpoints are routable by the nginx reverse proxy; skip raw TCP (e.g. mqtt, mqtts). */
function isHttpOrWebSocket(ep: EndpointDescriptor | undefined): boolean {
  if (!ep) return false;
  if (ep.tags?.includes('websocket')) return true;
  const p = (ep.protocol ?? '').toLowerCase();
  return p === 'http' || p === 'https' || p === 'ws' || p === 'wss';
}

/** @intent Get external host for a specific role (e.g. dashboard) for the given env; used for multi-route components. */
function getExternalHostForRole(
  infra: ComponentInfra | undefined,
  env: string,
  role: string,
): string | undefined {
  if (!infra) return undefined;
  const envBlock = infra.environments?.[env]?.endpoints?.external;
  const defaultBlock = infra.default?.endpoints?.external;
  const ext = envBlock ?? defaultBlock;
  const ep =
    ext?.roleKeyed?.[role] ??
    (role === 'primary' ? ext?.default ?? ext?.endpoints?.[0] : undefined);
  return ep?.host;
}

/** @intent Find a derivation name that best matches the role (e.g. DASHBOARD_EXTERNAL_HOST for role dashboard). */
function findDerivationForRole(
  derivations: DerivationDescriptor[],
  role: string,
): string | undefined {
  const externalHostDerivs = derivations.filter(
    (d) =>
      d.name.endsWith('_EXTERNAL_HOST') ||
      (d.name.endsWith('_HOST') && !d.name.includes('INTERNAL')),
  );
  if (role === 'primary' || role === 'default') {
    return externalHostDerivs.find((d) => !d.name.includes('DASHBOARD'))?.name ?? externalHostDerivs[0]?.name;
  }
  const roleUpper = role.toUpperCase();
  return externalHostDerivs.find((d) => d.name.includes(roleUpper))?.name ?? externalHostDerivs[0]?.name;
}

/** @intent Build routes only for components with _EXTERNAL_HOST or _HOST derivations; supports multiple routes per component via external.roleKeyed (e.g. primary + dashboard). */
export function buildReverseProxyRoutes(
  entries: DiscoveryEntry[],
  infraByKey: Map<string, ComponentInfra>,
  env?: string,
  serviceNameByInstanceKey?: Map<string, string>,
): ReverseProxyRoute[] {
  const effectiveEnv = env ?? process.env.THONNAS_ENV ?? 'development';
  const out: ReverseProxyRoute[] = [];
  for (const entry of entries) {
    const infra = infraByKey.get(entry.componentKey);
    const derivations = infra?.default?.derivations ?? [];
    const hasExternalHostDeriv = derivations.some(
      (d) =>
        d.name.endsWith('_EXTERNAL_HOST') ||
        (d.name.endsWith('_HOST') && !d.name.includes('INTERNAL')),
    );
    if (!hasExternalHostDeriv) continue;
    const internal = infra?.default?.endpoints?.internal;
    const external = infra?.default?.endpoints?.external;
    const externalRoleKeyed = external?.roleKeyed;
    const internalRoleKeyed = internal?.roleKeyed;

    if (externalRoleKeyed && internalRoleKeyed && Object.keys(externalRoleKeyed).length > 0) {
      for (const role of Object.keys(externalRoleKeyed)) {
        const extEp = externalRoleKeyed[role];
        const intEp = internalRoleKeyed[role];
        if (!intEp?.host || intEp.port == null) continue;
        if (!isHttpOrWebSocket(intEp)) continue;
        if (!isTemplateHost(extEp?.host)) continue;
        const defaultHost = getExternalHostForRole(infra, effectiveEnv, role);
        if (!defaultHost) continue;
        // @intent FEAT-011: upstream must be the graph-resolved, alias-safe service name -- intEp.host may
        // be a literal componentKey or an unresolved {componentHost} token, neither of which is the actual
        // running Docker Compose service name once Phase 5's rendering has renamed it.
        const upstream = `${resolveUpstreamHost(entry, intEp.host, serviceNameByInstanceKey)}:${intEp.port}`;
        const websocket =
          (intEp.tags?.includes('websocket') ?? false) ||
          intEp.protocol === 'ws' ||
          intEp.protocol === 'wss';
        const envVar = findDerivationForRole(derivations, role) ?? derivations[0]?.name ?? '';
        out.push({
          envVar,
          upstream,
          websocket,
          componentKey: entry.componentKey,
          defaultHost,
        });
      }
      continue;
    }

    const defaultEp = internal?.default ?? internal?.endpoints?.[0];
    if (!defaultEp?.host || defaultEp.port == null) continue;
    if (!isHttpOrWebSocket(defaultEp)) continue;
    const upstream = `${resolveUpstreamHost(entry, defaultEp.host, serviceNameByInstanceKey)}:${defaultEp.port}`;
    const websocket =
      (defaultEp.tags?.includes('websocket') ?? false) ||
      defaultEp.protocol === 'ws' ||
      defaultEp.protocol === 'wss';
    const defaultHost = getExternalDefaultHost(infra, effectiveEnv);
    const externalHostDeriv = derivations.find(
      (d) =>
        d.name.endsWith('_EXTERNAL_HOST') ||
        (d.name.endsWith('_HOST') && !d.name.includes('INTERNAL')),
    );
    out.push({
      envVar: externalHostDeriv?.name ?? '',
      upstream,
      websocket,
      componentKey: entry.componentKey,
      ...(defaultHost ? { defaultHost } : {}),
    });
  }
  return out;
}

/** @intent Derive depends_on service names from routes (unique, order preserved; docker-compose requires unique array items). */
export function getDependsOnFromRoutes(routes: ReverseProxyRoute[]): string[] {
  const seen = new Set<string>();
  return routes
    .map((r) => r.upstream.split(':')[0])
    .filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
}

