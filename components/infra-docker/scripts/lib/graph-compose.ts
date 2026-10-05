// @intent FEAT-011: render a component's compose *template* into a concrete, generated compose
// fragment using thonnas-cli's infra-graph.json -- alias-safe service name, resolved host ports,
// and depends_on edges for strategy-resolved dependencies. Deliberately text-based, not a full YAML
// parse/re-serialize round trip: this codebase's existing compose-discovery code (extractServiceNames,
// et al.) is also text/line-based, and a real YAML library would silently drop the `# @intent ...`
// comments this project requires on every component's compose file.

export interface InfraGraphEndpoint {
  name: string;
  host: string;
  containerPort?: number;
  hostPort?: number;
}

export interface InfraGraphNode {
  instanceKey: string;
  componentKey: string;
  alias?: string;
  implementsStrategies: string[];
  serviceName: string;
  endpoints: InfraGraphEndpoint[];
}

export interface InfraGraphEdge {
  from: string;
  to: string;
  strategy: string;
  purpose: string;
  resolvedVia: 'unambiguous' | 'mapping';
}

export interface InfraGraph {
  schemaVersion: string;
  generatedAt: string;
  env: string;
  nodes: InfraGraphNode[];
  edges: InfraGraphEdge[];
  unresolved: unknown[];
  portConflicts: unknown[];
}

/** Every node another node's edges point at as `to`, keyed by that other node's serviceName. */
export function dependsOnServiceNames(graph: InfraGraph, node: InfraGraphNode): string[] {
  const targetInstanceKeys = graph.edges.filter((e) => e.from === node.instanceKey).map((e) => e.to);
  const byInstanceKey = new Map(graph.nodes.map((n) => [n.instanceKey, n]));
  const names = targetInstanceKeys
    .map((key) => byInstanceKey.get(key)?.serviceName)
    .filter((name): name is string => Boolean(name));
  // De-dupe: two purposes resolving to the same provider must not produce two identical depends_on lines.
  return Array.from(new Set(names));
}

/**
 * Substitute {serviceName} / {hostPort:<endpoint>} tokens (textually -- this also renames the
 * top-level `services:\n  {serviceName}:` key for free, since it's still just text before any
 * parsing happens) and inject a depends_on block for this instance's resolved strategy dependencies.
 *
 * Requires the template to declare exactly one top-level service, at the same 2-space top-level /
 * 4-space child indentation every compose fragment in this codebase already uses.
 */
export function renderComposeFragment(templateContent: string, node: InfraGraphNode, dependsOnRaw: string[]): string {
  const dependsOn = Array.from(new Set(dependsOnRaw));
  let content = templateContent.replaceAll('{serviceName}', node.serviceName);
  for (const endpoint of node.endpoints) {
    if (endpoint.hostPort !== undefined) {
      content = content.replaceAll(`{hostPort:${endpoint.name}}`, String(endpoint.hostPort));
    }
  }

  if (dependsOn.length === 0) {
    return content;
  }

  const serviceKeyPattern = new RegExp(`^(  ${escapeRegExp(node.serviceName)}:)\\s*$`, 'm');
  if (!serviceKeyPattern.test(content)) {
    throw new Error(
      `Compose template for "${node.instanceKey}" does not declare a top-level service named ` +
        `"${node.serviceName}" at the expected 2-space indentation after token substitution -- ` +
        'cannot inject depends_on. Templates must use {serviceName} as their sole top-level service key.',
    );
  }

  // @intent A real component's template may already declare its own depends_on (e.g. api-nest's
  // wait-for-mongo-init). YAML forbids duplicate mapping keys -- inserting a second depends_on:
  // unconditionally (the original approach) makes docker compose config hard-fail with "mapping
  // key already defined" for any such component. Merge into the existing block instead.
  const merged = mergeIntoExistingDependsOn(content, node.serviceName, dependsOn);
  if (merged !== null) {
    return merged;
  }

  const dependsOnBlock = `    depends_on:\n${dependsOn.map((name) => `      - ${name}`).join('\n')}\n`;
  return content.replace(serviceKeyPattern, `$1\n${dependsOnBlock}`);
}

/**
 * Find an existing `depends_on:` block (4-space indent) inside the named service's block and add
 * any `newDeps` not already listed, preserving whichever form (plain list vs service->condition
 * map) the template already used. Returns null when the service has no existing depends_on block
 * at all, so the caller falls back to inserting a fresh one.
 */
function mergeIntoExistingDependsOn(content: string, serviceName: string, newDeps: string[]): string | null {
  const lines = content.split('\n');
  const serviceLineIdx = lines.findIndex((l) => l === `  ${serviceName}:`);
  if (serviceLineIdx === -1) return null;

  let dependsOnIdx = -1;
  for (let i = serviceLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && /^ {0,2}\S/.test(line)) break; // next sibling/top-level key: service block ended
    if (line === '    depends_on:') {
      dependsOnIdx = i;
      break;
    }
  }
  if (dependsOnIdx === -1) return null;

  let endIdx = dependsOnIdx + 1;
  const existingNames = new Set<string>();
  let isMappingForm = false;
  while (endIdx < lines.length) {
    const line = lines[endIdx];
    const dashMatch = line.match(/^ {6}- (\S+)/);
    const mapMatch = line.match(/^ {6}([A-Za-z0-9_.-]+):\s*$/);
    if (dashMatch) {
      existingNames.add(dashMatch[1]);
      endIdx++;
      continue;
    }
    if (mapMatch) {
      isMappingForm = true;
      existingNames.add(mapMatch[1]);
      endIdx++;
      while (endIdx < lines.length && /^ {8}\S/.test(lines[endIdx])) endIdx++;
      continue;
    }
    break;
  }

  const toAdd = newDeps.filter((name) => !existingNames.has(name));
  if (toAdd.length > 0) {
    const newLines = isMappingForm
      ? toAdd.flatMap((name) => [`      ${name}:`, '        condition: service_started'])
      : toAdd.map((name) => `      - ${name}`);
    lines.splice(endIdx, 0, ...newLines);
  }
  return lines.join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Map every discovered entry's instanceKey to its graph-resolved, alias-safe serviceName.
 * Shared by both the internal compose-topology path (e2e-build.ts) and the external/
 * reverse-proxy path (compose-discovery.ts, reverse-proxy.ts) -- one resolution, not two
 * independently-alias-blind ones.
 */
export function serviceNameByInstanceKey(graph: InfraGraph): Map<string, string> {
  return new Map(graph.nodes.map((n) => [n.instanceKey, n.serviceName]));
}

export interface GraphDiscoveryEntry {
  componentKey: string;
  instanceKey: string;
}

/**
 * Match each discovered component entry to its infra-graph node. Throws when a discovered
 * component has no matching node (a stale graph -- fail closed, same contract as every other
 * FEAT-011 read-only consumer, rather than silently falling back to the pre-graph raw-include
 * behavior for just that one component).
 */
export function matchEntriesToNodes<T extends GraphDiscoveryEntry>(
  entries: T[],
  graph: InfraGraph,
): { entry: T; node: InfraGraphNode }[] {
  const nodesByInstanceKey = new Map(graph.nodes.map((n) => [n.instanceKey, n]));
  return entries.map((entry) => {
    const node = nodesByInstanceKey.get(entry.instanceKey);
    if (!node) {
      throw new Error(
        `No infra-graph node found for "${entry.instanceKey}" (${entry.componentKey}). The graph is stale -- ` +
          `re-run "thonnas infra graph --env ${graph.env}" after installing/removing components.`,
      );
    }
    return { entry, node };
  });
}

