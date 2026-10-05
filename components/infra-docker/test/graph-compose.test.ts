// @intent Test template rendering: {serviceName}/{hostPort:*} substitution and depends_on injection
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  renderComposeFragment,
  dependsOnServiceNames,
  matchEntriesToNodes,
  type InfraGraph,
  type InfraGraphNode,
} from '../scripts/lib/graph-compose.js';

const cacheRedisTemplate = `services:
  {serviceName}:
    image: redis:7.2-alpine
    restart: unless-stopped
    ports:
      - "{hostPort:primary}:6379"
    networks:
      - thonnas-network
`;

function mkNode(overrides: Partial<InfraGraphNode>): InfraGraphNode {
  return {
    instanceKey: 'cache-redis',
    componentKey: 'cache-redis',
    implementsStrategies: ['infra.cache.keyvalue'],
    serviceName: 'cache-redis',
    endpoints: [{ name: 'primary', host: 'cache-redis', containerPort: 6379, hostPort: 6379 }],
    ...overrides,
  };
}

describe('renderComposeFragment', () => {
  it('substitutes {serviceName} into the top-level service key', () => {
    const node = mkNode({ instanceKey: 'cache-redis::a', alias: 'a', serviceName: 'a' });
    const rendered = renderComposeFragment(cacheRedisTemplate, node, []);
    assert.match(rendered, /^services:\n {2}a:$/m);
    assert.doesNotMatch(rendered, /\{serviceName\}/);
  });

  it('substitutes {hostPort:<endpoint>} with the resolved value', () => {
    const node = mkNode({ endpoints: [{ name: 'primary', host: 'cache-redis', containerPort: 6379, hostPort: 6380 }] });
    const rendered = renderComposeFragment(cacheRedisTemplate, node, []);
    assert.match(rendered, /"6380:6379"/);
    assert.doesNotMatch(rendered, /\{hostPort/);
  });

  it('injects a depends_on block when the node has resolved dependencies', () => {
    const node = mkNode({});
    const rendered = renderComposeFragment(cacheRedisTemplate, node, ['some-other-service']);
    assert.match(rendered, /^ {2}cache-redis:\n {4}depends_on:\n {6}- some-other-service$/m);
  });

  it('emits no depends_on block when there are no resolved dependencies', () => {
    const node = mkNode({});
    const rendered = renderComposeFragment(cacheRedisTemplate, node, []);
    assert.doesNotMatch(rendered, /depends_on/);
  });

  it('de-dupes multiple edges to the same shared provider into one depends_on entry', () => {
    const node = mkNode({});
    const rendered = renderComposeFragment(cacheRedisTemplate, node, ['shared-cache', 'shared-cache']);
    const matches = rendered.match(/- shared-cache/g) ?? [];
    assert.strictEqual(matches.length, 1);
  });

  it('throws a clear error when the template does not declare {serviceName} as its sole top-level key', () => {
    const badTemplate = 'services:\n  hardcoded-name:\n    image: redis\n';
    const node = mkNode({});
    assert.throws(() => renderComposeFragment(badTemplate, node, ['x']), /does not declare a top-level service/);
  });

  it('merges into an existing plain-list depends_on instead of emitting a duplicate key', () => {
    const template = `services:
  {serviceName}:
    image: redis:7.2-alpine
    depends_on:
      - some-init
    networks:
      - thonnas-network
`;
    const node = mkNode({});
    const rendered = renderComposeFragment(template, node, ['shared-cache']);
    assert.strictEqual((rendered.match(/^ {4}depends_on:$/gm) ?? []).length, 1);
    assert.match(rendered, /- some-init/);
    assert.match(rendered, /- shared-cache/);
  });

  it('merges into an existing service->condition depends_on map, preserving that form', () => {
    const template = `services:
  {serviceName}:
    image: node:20
    depends_on:
      dbt-mongo-init:
        condition: service_completed_successfully
    networks:
      - thonnas-network
`;
    const node = mkNode({});
    const rendered = renderComposeFragment(template, node, ['metrics-otel-signoz']);
    assert.strictEqual((rendered.match(/^ {4}depends_on:$/gm) ?? []).length, 1);
    assert.match(rendered, /dbt-mongo-init:\n {8}condition: service_completed_successfully/);
    assert.match(rendered, /metrics-otel-signoz:\n {8}condition: service_started/);
  });

  it('does not duplicate a dependency already present in the existing depends_on block', () => {
    const template = `services:
  {serviceName}:
    image: redis:7.2-alpine
    depends_on:
      - shared-cache
    networks:
      - thonnas-network
`;
    const node = mkNode({});
    const rendered = renderComposeFragment(template, node, ['shared-cache']);
    const matches = rendered.match(/- shared-cache/g) ?? [];
    assert.strictEqual(matches.length, 1);
  });
});

describe('dependsOnServiceNames', () => {
  const graph: InfraGraph = {
    schemaVersion: '1',
    generatedAt: '2026-01-01T00:00:00Z',
    env: 'development',
    nodes: [
      mkNode({ instanceKey: 'dummy-consumer', componentKey: 'dummy-consumer', serviceName: 'dummy-consumer', endpoints: [] }),
      mkNode({ instanceKey: 'cache-redis::a', alias: 'a', serviceName: 'a' }),
    ],
    edges: [
      {
        from: 'dummy-consumer',
        to: 'cache-redis::a',
        strategy: 'infra.cache.keyvalue',
        purpose: 'infra.cache.keyvalue',
        resolvedVia: 'mapping',
      },
    ],
    unresolved: [],
    portConflicts: [],
  };

  it('resolves an edge target instanceKey to its serviceName', () => {
    const consumer = graph.nodes[0];
    assert.deepStrictEqual(dependsOnServiceNames(graph, consumer), ['a']);
  });

  it('returns an empty array for a node with no outgoing edges', () => {
    const provider = graph.nodes[1];
    assert.deepStrictEqual(dependsOnServiceNames(graph, provider), []);
  });
});

describe('matchEntriesToNodes', () => {
  const graph: InfraGraph = {
    schemaVersion: '1',
    generatedAt: '2026-01-01T00:00:00Z',
    env: 'development',
    nodes: [mkNode({ instanceKey: 'cache-redis::a', alias: 'a', serviceName: 'a' })],
    edges: [],
    unresolved: [],
    portConflicts: [],
  };

  it('matches a discovered entry to its graph node by instanceKey', () => {
    const entries = [{ componentKey: 'cache-redis', instanceKey: 'cache-redis::a' }];
    const matched = matchEntriesToNodes(entries, graph);
    assert.strictEqual(matched.length, 1);
    assert.strictEqual(matched[0].node.serviceName, 'a');
  });

  it('throws a clear, actionable error for a stale graph missing an entry\'s instanceKey', () => {
    const entries = [{ componentKey: 'cache-redis', instanceKey: 'cache-redis::c' }];
    assert.throws(
      () => matchEntriesToNodes(entries, graph),
      /No infra-graph node found for "cache-redis::c".*thonnas infra graph --env development/s,
    );
  });
});

