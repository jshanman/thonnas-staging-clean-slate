// @intent Extract compose discovery and validation logic for testability; used by e2e-build

export interface DiscoveryEntry {
  componentKey: string;
  /** componentKey::alias, or bare componentKey when unaliased -- matches thonnas-cli's own identity. */
  instanceKey?: string;
  composePath: string;
  relativePath: string;
}

/**
 * FEAT-011: resolve the alias-safe service name for an entry. Prefers the graph-provided map
 * (the actual, alias-resolved identity the compose fragment was rendered with); falls back to
 * the declared host (thonnas-infra.json's internal.default.host, which may itself already be a
 * legitimate custom value) and only then to the bare componentKey -- preserving the original
 * fallback chain for callers/tests that don't pass a map at all.
 */
function resolveServiceName(
  entry: DiscoveryEntry,
  declaredHost: string | undefined,
  serviceNameByInstanceKey?: Map<string, string>,
): string {
  const fallback = declaredHost ?? entry.componentKey;
  if (!serviceNameByInstanceKey || !entry.instanceKey) return fallback;
  return serviceNameByInstanceKey.get(entry.instanceKey) ?? fallback;
}

export interface RuntimeStrategy {
  key?: string;
  ports?: number[];
}

export interface EndpointDescriptor {
  host?: string;
  port?: number;
  protocol?: string;
}

export interface EndpointSet {
  default?: EndpointDescriptor;
  endpoints?: EndpointDescriptor[];
  hostnamePattern?: string;
  /** Role-keyed endpoints (e.g. primary, dashboard) from normalizeComponentInfra; one published service per role for Route53. */
  roleKeyed?: Record<string, EndpointDescriptor>;
}

export interface ComponentInfraBlock {
  // @intent Strategy name varies by component (runtime, dashboard, collector, cache, document-store, ...);
  // find the entry whose `key` matches, don't assume the name is always "runtime".
  strategies?: Record<string, RuntimeStrategy>;
  endpoints?: {
    internal?: EndpointSet;
    external?: EndpointSet;
  };
}

export interface ComponentInfra {
  default?: ComponentInfraBlock;
  // @intent Populated by normalizeComponentInfra, which merges top-level env-sibling blocks
  // (e.g. "beta": {...}) into this map so both infra-docker and infra-cdk read the same file the same way.
  environments?: Record<string, ComponentInfraBlock>;
}

export interface PublishedService {
  name: string;
  port: number;
  protocol: string;
  hostnamePattern: string;
}

/** @intent Parse service names from docker-compose YAML services block */
export function extractServiceNames(content: string): string[] {
  const lines = content.split(/\r?\n/);
  let inServices = false;
  let baseIndent = 0;
  const names: string[] = [];
  for (const line of lines) {
    if (!inServices) {
      const m = line.match(/^(\s*)services:\s*$/);
      if (m) {
        inServices = true;
        baseIndent = m[1].length;
      }
      continue;
    }
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const indent = line.search(/\S/);
    if (indent <= baseIndent) break;
    const sm = line.match(new RegExp(`^\\s{${baseIndent + 2}}([A-Za-z0-9._-]+):\\s*$`));
    if (sm) names.push(sm[1]);
  }
  return names;
}

function isTemplateHost(host: string | undefined): boolean {
  return typeof host === 'string' && (host.includes('{env}') || host.includes('{rootDomain}'));
}

/** @intent Build published services from components with external endpoint; port/protocol from external (e.g. 443/https), name from internal for routing. SG and Route53 use these; nginx upstream uses internal from routes. When external.roleKeyed exists (e.g. primary + dashboard), emit one service per role so Route53 gets an A record per hostname.
 * @intent compose-host is env-agnostic by design: infra-docker owns "run everything as one docker-compose
 * stack," whether the host is this local machine (development) or an EC2 instance infra-cdk provisions
 * (beta). Resolve the given env's strategies (falling back to `default` when no env-specific override
 * exists, matching infra-cdk's own resolution), and look for `infra.container.compose-host` there --
 * NOT `infra.container.simple-vm`, which is a distinct, deliberately-chosen single-dedicated-EC2 runtime
 * with its own separate release path, not part of the shared compose-host stack. */
export function buildPublishedServices(
  entries: DiscoveryEntry[],
  infraByKey: Map<string, ComponentInfra>,
  env: string,
  serviceNameByInstanceKey?: Map<string, string>,
): PublishedService[] {
  const out: PublishedService[] = [];
  for (const entry of entries) {
    const infra = infraByKey.get(entry.componentKey);
    const envBlock: ComponentInfraBlock | undefined = infra?.environments?.[env];
    const def: ComponentInfraBlock | undefined =
      envBlock?.strategies || envBlock?.endpoints ? envBlock : infra?.default;
    const strategies = def?.strategies;
    const composeHostStrategy = strategies
      ? Object.values(strategies).find((s) => s?.key === 'infra.container.compose-host')
      : undefined;
    // @intent Internal hostname/port is env-invariant (the docker-network address never changes),
    // so it normally lives only in `default`, not repeated in every env override. Fall back to it.
    const internal = def?.endpoints?.internal ?? infra?.default?.endpoints?.internal;
    const external = def?.endpoints?.external ?? infra?.default?.endpoints?.external;
    if (!composeHostStrategy || !internal?.default) continue;

    const resolvedName = resolveServiceName(entry, internal.default?.host, serviceNameByInstanceKey);
    const internalRoleKeyed = internal?.roleKeyed;
    const externalRoleKeyed = external?.roleKeyed;

    if (externalRoleKeyed && internalRoleKeyed && Object.keys(externalRoleKeyed).length > 0) {
      const primaryExtHost = external.default?.host ?? externalRoleKeyed.primary?.host ?? externalRoleKeyed.default?.host;
      for (const role of Object.keys(externalRoleKeyed)) {
        const extEp = externalRoleKeyed[role];
        if (!extEp?.host || extEp.port == null || !isTemplateHost(extEp.host)) continue;
        if (extEp.host === primaryExtHost && role !== 'primary' && role !== 'default') continue;
        const protocol = extEp.protocol === 'https' ? 'https' : 'http';
        // @intent FEAT-011: name is the internal upstream/service identity -- must be the graph-resolved,
        // alias-safe name (not internal.default.host, which may be a literal componentKey or an
        // unresolved {componentHost} token), same identity the compose fragment was actually rendered with.
        const serviceName = role === 'primary' || role === 'default' ? resolvedName : `${resolvedName}-${role}`;
        out.push({
          name: serviceName,
          port: extEp.port,
          protocol,
          hostnamePattern: extEp.host,
        });
      }
      continue;
    }

    const defaultEp = external?.default ?? external?.endpoints?.[0];
    if (!defaultEp || defaultEp.port == null) continue;
    const port = defaultEp.port;
    const protocol = defaultEp.protocol ?? 'https';
    if (port == null) continue;
    const primaryHost = defaultEp.host;
    const isTemplate = isTemplateHost(primaryHost);
    // @intent FEAT-011: the fallback pattern must be alias-qualified too -- two aliased instances both
    // externally published can't share the same public hostname, any more than they can share a service name.
    const hostnamePattern = external?.hostnamePattern ?? (isTemplate ? primaryHost! : `{env}.${resolvedName}.{rootDomain}`);
    out.push({
      name: resolvedName,
      port,
      protocol,
      hostnamePattern,
    });
  }
  return out;
}

/** @intent Parse port mappings from compose content; extracts env var and default host port for conflict detection */
export function extractHostPortMappings(content: string): { envVar: string | null; defaultHostPort: number }[] {
  const results: { envVar: string | null; defaultHostPort: number }[] = [];
  // Match: - "${VAR:-123}:456" or - "123:456"
  const envPortRe = /^\s*-\s*"\$\{([^}:]+):-(\d+)\}:(\d+)"\s*(?:#|$)/;
  const literalRe = /^\s*-\s*"(\d+):\d+"\s*(?:#|$)/;
  for (const line of content.split(/\r?\n/)) {
    const envMatch = line.match(envPortRe);
    if (envMatch) {
      results.push({ envVar: envMatch[1], defaultHostPort: parseInt(envMatch[2], 10) });
      continue;
    }
    const litMatch = line.match(literalRe);
    if (litMatch) {
      results.push({ envVar: null, defaultHostPort: parseInt(litMatch[1], 10) });
    }
  }
  return results;
}

/** @intent Fail when two components use the same default host port (env var refs enable conflict detection) */
export async function validateHostPortConflicts(
  entries: DiscoveryEntry[],
  readFile: (filePath: string) => Promise<string>,
): Promise<void> {
  const byPort = new Map<number, { componentKey: string; envVar: string | null }[]>();
  for (const entry of entries) {
    const content = await readFile(entry.composePath);
    const mappings = extractHostPortMappings(content);
    for (const { envVar, defaultHostPort } of mappings) {
      const list = byPort.get(defaultHostPort) ?? [];
      list.push({ componentKey: entry.componentKey, envVar });
      byPort.set(defaultHostPort, list);
    }
  }
  const conflicts: string[] = [];
  for (const [port, list] of byPort) {
    if (list.length <= 1) continue;
    const details = list.map((x) => (x.envVar ? `${x.componentKey} (${x.envVar})` : x.componentKey)).join(', ');
    conflicts.push(`Host port ${port}: ${details}`);
  }
  if (conflicts.length > 0) {
    throw new Error(
      'Host port conflict: multiple components use the same default host port. ' +
        'Set distinct env vars (e.g. API_NEST_DEBUG_PORT, API_NEST_THONNAS_MARKETPLACE_DEBUG_PORT) with different defaults in docker-compose.yml, or override in .env.\n' +
        'Conflicts:\n' +
        conflicts.map((c) => `  - ${c}`).join('\n'),
    );
  }
}

/** @intent Fail when two components use the same internal host+port (duplicate upstream); same port in different containers is allowed */
export function validatePublishedServicePortConflicts(
  entries: DiscoveryEntry[],
  infraByKey: Map<string, ComponentInfra>,
  env: string,
  serviceNameByInstanceKey?: Map<string, string>,
): void {
  const byUpstream = new Map<string, { componentKey: string; name: string }[]>();
  for (const entry of entries) {
    const infra = infraByKey.get(entry.componentKey);
    const envBlock: ComponentInfraBlock | undefined = infra?.environments?.[env];
    const def: ComponentInfraBlock | undefined =
      envBlock?.strategies || envBlock?.endpoints ? envBlock : infra?.default;
    const strategies = def?.strategies;
    const composeHostStrategy = strategies
      ? Object.values(strategies).find((s) => s?.key === 'infra.container.compose-host')
      : undefined;
    const internal = def?.endpoints?.internal ?? infra?.default?.endpoints?.internal;
    if (!composeHostStrategy || !internal?.default) continue;
    const port = internal.default.port ?? composeHostStrategy.ports?.[0];
    if (port == null) continue;
    // @intent FEAT-011: use the graph-resolved name -- two aliased instances sharing a container port
    // is fine (separate network namespaces); only a genuine name collision is a real upstream conflict.
    const name = resolveServiceName(entry, internal.default.host, serviceNameByInstanceKey);
    const key = `${name}:${port}`;
    const list = byUpstream.get(key) ?? [];
    list.push({ componentKey: entry.componentKey, name });
    byUpstream.set(key, list);
  }
  const conflicts: string[] = [];
  for (const [upstream, list] of byUpstream) {
    if (list.length <= 1) continue;
    const components = list.map((x) => `${x.componentKey} (service: ${x.name})`).join(', ');
    conflicts.push(`Upstream ${upstream}: ${components}`);
  }
  if (conflicts.length > 0) {
    throw new Error(
      'Published service conflict: duplicate upstream (host:port). Each component must have a unique internal default.\n' +
        "Fix by changing the port or host in one of the component's thonnas-infra.json (default.endpoints.internal).\n" +
        'Conflicts:\n' +
        conflicts.map((c) => `  - ${c}`).join('\n'),
    );
  }
}


