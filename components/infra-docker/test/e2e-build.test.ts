// @intent Test e2e-build use cases: service extraction, published services, port conflict validation
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildPublishedServices,
  extractHostPortMappings,
  extractServiceNames,
  type ComponentInfra,
  type DiscoveryEntry,
  validateHostPortConflicts,
  validatePublishedServicePortConflicts,
} from '../scripts/lib/compose-discovery.js';
import {
  collectLocalstackServicesFromInfra,
  unionLocalstackServices,
} from '../scripts/lib/localstack-services.js';

function mkEntry(componentKey: string): DiscoveryEntry {
  return {
    componentKey,
    composePath: `/components/${componentKey}/docker-compose.yml`,
    relativePath: `../${componentKey}/docker-compose.yml`,
  };
}

function mkAliasedEntry(componentKey: string, instanceKey: string): DiscoveryEntry {
  return { ...mkEntry(componentKey), instanceKey };
}

function mkInfraSimpleVm(host: string, port: number, hostnamePattern?: string): ComponentInfra {
  const pattern = hostnamePattern ?? `{env}.${host}.{rootDomain}`;
  return {
    default: {
      strategies: { runtime: { key: 'infra.container.compose-host', ports: [port] } },
      endpoints: {
        internal: { default: { host, port, protocol: 'http' } },
        external: { hostnamePattern: pattern, default: { host: pattern, port: 443, protocol: 'https' } },
      },
    },
  };
}

describe('extractServiceNames', () => {
  it('extracts service names from docker-compose YAML', () => {
    const yaml = `
services:
  api-nest:
    image: node:20
  web-angular:
    build: .
`;
    const names = extractServiceNames(yaml);
    assert.deepStrictEqual(names, ['api-nest', 'web-angular']);
  });

  it('returns empty array when no services block', () => {
    const yaml = 'version: "3"\nnetworks:\n  default: {}';
    const names = extractServiceNames(yaml);
    assert.deepStrictEqual(names, []);
  });

  it('handles single service', () => {
    const yaml = `
services:
  cache-redis:
    image: redis:alpine
`;
    const names = extractServiceNames(yaml);
    assert.deepStrictEqual(names, ['cache-redis']);
  });

  it('handles service names with hyphens and underscores', () => {
    const yaml = `
services:
  api-nest-thonnas-marketplace:
    build: .
  dbt_mongo_primary:
    image: mongo
`;
    const names = extractServiceNames(yaml);
    assert.deepStrictEqual(names, ['api-nest-thonnas-marketplace', 'dbt_mongo_primary']);
  });

  it('ignores commented lines', () => {
    const yaml = `
services:
  # api-old: {}
  api-nest:
    image: node
`;
    const names = extractServiceNames(yaml);
    assert.deepStrictEqual(names, ['api-nest']);
  });
});

describe('buildPublishedServices', () => {
  it('returns published services only for compose-host runtime with external endpoint (port from external)', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest'), mkEntry('cache-redis')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['api-nest', mkInfraSimpleVm('api-nest', 3000)],
      ['cache-redis', { default: {} }],
    ]);
    const services = buildPublishedServices(entries, infraByKey, 'beta');
    assert.strictEqual(services.length, 1);
    assert.deepStrictEqual(services[0], {
      name: 'api-nest',
      port: 443,
      protocol: 'https',
      hostnamePattern: '{env}.api-nest.{rootDomain}',
    });
  });

  it('uses componentKey as host when internal.default.host is missing', () => {
    const entries: DiscoveryEntry[] = [mkEntry('web-angular')];
    const infra: ComponentInfra = {
      default: {
        strategies: { runtime: { key: 'infra.container.compose-host', ports: [4200] } },
        endpoints: {
          internal: { default: { port: 4200 } },
          external: { hostnamePattern: '{env}.web.{rootDomain}', default: { port: 443, protocol: 'https' } },
        },
      },
    };
    const infraByKey = new Map([['web-angular', infra]]);
    const services = buildPublishedServices(entries, infraByKey, 'beta');
    assert.strictEqual(services[0].name, 'web-angular');
  });

  it('uses external.hostnamePattern when present', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest')];
    const infraByKey = new Map([
      ['api-nest', mkInfraSimpleVm('api-nest', 3000, 'api.{rootDomain}')],
    ]);
    const services = buildPublishedServices(entries, infraByKey, 'beta');
    assert.strictEqual(services[0].hostnamePattern, 'api.{rootDomain}');
  });

  it('skips components without compose-host runtime', () => {
    const entries: DiscoveryEntry[] = [mkEntry('other')];
    const infraByKey = new Map([
      [
        'other',
        {
          default: {
            strategies: { runtime: { key: 'infra.container.other', ports: [8080] } },
            endpoints: { internal: { default: { host: 'other', port: 8080 } } },
          },
        },
      ],
    ]);
    const services = buildPublishedServices(entries, infraByKey, 'beta');
    assert.strictEqual(services.length, 0);
  });

  it('emits two published services when external has roleKeyed (primary + dashboard)', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-growthbook')];
    const infraByKey = new Map([
      [
        'api-growthbook',
        {
          default: {
            strategies: { runtime: { key: 'infra.container.compose-host', ports: [3100] } },
            endpoints: {
              internal: {
                default: { host: 'api-growthbook', port: 3100, protocol: 'http' },
                roleKeyed: {
                  primary: { host: 'api-growthbook', port: 3100, protocol: 'http' },
                  dashboard: { host: 'api-growthbook', port: 3000, protocol: 'http' },
                },
              },
              external: {
                default: { host: '{env}.growthbook.{rootDomain}', port: 80, protocol: 'http' },
                roleKeyed: {
                  primary: { host: '{env}.growthbook.{rootDomain}', port: 80, protocol: 'http' },
                  dashboard: { host: '{env}.growthbook-dashboard.{rootDomain}', port: 80, protocol: 'http' },
                },
              },
            },
          },
        },
      ],
    ]);
    const services = buildPublishedServices(entries, infraByKey, 'beta');
    assert.strictEqual(services.length, 2);
    const primary = services.find((s) => s.hostnamePattern.includes('growthbook.'));
    const dashboard = services.find((s) => s.hostnamePattern.includes('growthbook-dashboard'));
    assert.ok(primary, 'primary service');
    assert.ok(dashboard, 'dashboard service');
    assert.strictEqual(primary!.name, 'api-growthbook');
    assert.strictEqual(dashboard!.name, 'api-growthbook-dashboard');
    assert.strictEqual(dashboard!.hostnamePattern, '{env}.growthbook-dashboard.{rootDomain}');
  });

  it('uses the graph-resolved serviceName (not the componentKey) for both name and hostnamePattern fallback when an instanceKey map is provided', () => {
    const entries: DiscoveryEntry[] = [mkAliasedEntry('cache-redis', 'cache-redis::a')];
    const infraByKey = new Map<string, ComponentInfra>([
      [
        'cache-redis',
        { default: { strategies: { runtime: { key: 'infra.container.compose-host', ports: [6379] } }, endpoints: { internal: { default: { port: 6379 } }, external: { default: { port: 443, protocol: 'https' } } } } },
      ],
    ]);
    const serviceNameByInstanceKey = new Map([['cache-redis::a', 'cache-redis-a']]);
    const services = buildPublishedServices(entries, infraByKey, 'beta', serviceNameByInstanceKey);
    assert.strictEqual(services[0].name, 'cache-redis-a');
    assert.strictEqual(services[0].hostnamePattern, '{env}.cache-redis-a.{rootDomain}');
  });

  it('falls back to the declared host when the entry has no instanceKey, even with a map present', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest')];
    const infraByKey = new Map<string, ComponentInfra>([['api-nest', mkInfraSimpleVm('api-nest', 3000)]]);
    const serviceNameByInstanceKey = new Map([['api-nest::other', 'irrelevant']]);
    const services = buildPublishedServices(entries, infraByKey, 'beta', serviceNameByInstanceKey);
    assert.strictEqual(services[0].name, 'api-nest');
  });

  it('distinguishes two aliased instances of the same component with different graph-resolved names', () => {
    const entries: DiscoveryEntry[] = [
      mkAliasedEntry('cache-redis', 'cache-redis::a'),
      mkAliasedEntry('cache-redis', 'cache-redis::b'),
    ];
    const infra: ComponentInfra = {
      default: {
        strategies: { runtime: { key: 'infra.container.compose-host', ports: [6379] } },
        endpoints: { internal: { default: { port: 6379 } }, external: { default: { port: 443, protocol: 'https' } } },
      },
    };
    const infraByKey = new Map<string, ComponentInfra>([['cache-redis', infra]]);
    const serviceNameByInstanceKey = new Map([
      ['cache-redis::a', 'cache-redis-a'],
      ['cache-redis::b', 'cache-redis-b'],
    ]);
    const services = buildPublishedServices(entries, infraByKey, 'beta', serviceNameByInstanceKey);
    assert.strictEqual(services.length, 2);
    assert.deepStrictEqual(services.map((s) => s.name).sort(), ['cache-redis-a', 'cache-redis-b']);
    assert.deepStrictEqual(services.map((s) => s.hostnamePattern).sort(), [
      '{env}.cache-redis-a.{rootDomain}',
      '{env}.cache-redis-b.{rootDomain}',
    ]);
  });
});

describe('validatePublishedServicePortConflicts', () => {
  it('does not throw when no port conflicts', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest'), mkEntry('web-angular')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['api-nest', mkInfraSimpleVm('api-nest', 3000)],
      ['web-angular', mkInfraSimpleVm('web-angular', 4200)],
    ]);
    assert.doesNotThrow(() => validatePublishedServicePortConflicts(entries, infraByKey, 'beta'));
  });

  it('does not throw when different components use same port (different upstream host)', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest'), mkEntry('web-react-docusaurus')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['api-nest', mkInfraSimpleVm('api-nest', 3000)],
      ['web-react-docusaurus', mkInfraSimpleVm('web-react-docusaurus', 3000)],
    ]);
    assert.doesNotThrow(() => validatePublishedServicePortConflicts(entries, infraByKey, 'beta'));
  });

  it('throws when two components share the same upstream (host:port)', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest'), mkEntry('api-nest-dupe')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['api-nest', mkInfraSimpleVm('api-nest', 3000)],
      ['api-nest-dupe', mkInfraSimpleVm('api-nest', 3000)], // same host:port
    ]);
    assert.throws(
      () => validatePublishedServicePortConflicts(entries, infraByKey, 'beta'),
      /duplicate upstream|Upstream api-nest:3000/,
    );
  });

  it('includes fix hint in error message', () => {
    const entries: DiscoveryEntry[] = [mkEntry('a'), mkEntry('b')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['a', mkInfraSimpleVm('same-host', 80)],
      ['b', mkInfraSimpleVm('same-host', 80)],
    ]);
    assert.throws(
      () => validatePublishedServicePortConflicts(entries, infraByKey, 'beta'),
      /thonnas-infra\.json/,
    );
  });

  it('does not flag two aliased instances sharing a container port as a conflict once graph-resolved names disambiguate them', () => {
    const entries: DiscoveryEntry[] = [
      mkAliasedEntry('cache-redis', 'cache-redis::a'),
      mkAliasedEntry('cache-redis', 'cache-redis::b'),
    ];
    const infraByKey = new Map<string, ComponentInfra>([
      ['cache-redis', mkInfraSimpleVm('cache-redis', 6379)],
    ]);
    const serviceNameByInstanceKey = new Map([
      ['cache-redis::a', 'cache-redis-a'],
      ['cache-redis::b', 'cache-redis-b'],
    ]);
    assert.doesNotThrow(() =>
      validatePublishedServicePortConflicts(entries, infraByKey, 'beta', serviceNameByInstanceKey),
    );
  });

  it('still throws for a genuine name collision even when a serviceNameByInstanceKey map is provided', () => {
    const entries: DiscoveryEntry[] = [mkAliasedEntry('a', 'a'), mkAliasedEntry('b', 'b')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['a', mkInfraSimpleVm('same-host', 80)],
      ['b', mkInfraSimpleVm('same-host', 80)],
    ]);
    const serviceNameByInstanceKey = new Map<string, string>();
    assert.throws(
      () => validatePublishedServicePortConflicts(entries, infraByKey, 'beta', serviceNameByInstanceKey),
      /duplicate upstream|Upstream same-host:80/,
    );
  });
});

describe('extractHostPortMappings', () => {
  it('extracts env var and default host port from ${VAR:-N}:containerPort', () => {
    const yaml = `
services:
  api-nest:
    ports:
      - "\${API_NEST_APP_PORT:-3000}:3000"
      - "\${API_NEST_DEBUG_PORT:-9229}:9229"
`;
    const mappings = extractHostPortMappings(yaml);
    assert.deepStrictEqual(mappings, [
      { envVar: 'API_NEST_APP_PORT', defaultHostPort: 3000 },
      { envVar: 'API_NEST_DEBUG_PORT', defaultHostPort: 9229 },
    ]);
  });

  it('extracts literal host port from "host:container"', () => {
    const yaml = `
    ports:
      - "8088:8080"
`;
    const mappings = extractHostPortMappings(yaml);
    assert.deepStrictEqual(mappings, [{ envVar: null, defaultHostPort: 8088 }]);
  });

  it('returns empty when no port lines match', () => {
    const yaml = 'services:\n  x:\n    image: nginx\n';
    assert.deepStrictEqual(extractHostPortMappings(yaml), []);
  });
});

describe('validateHostPortConflicts', () => {
  it('does not throw when default host ports differ', async () => {
    const entries: DiscoveryEntry[] = [
      { componentKey: 'api-nest', composePath: '/a/api-nest/docker-compose.yml', relativePath: 'a/api-nest/docker-compose.yml' },
      { componentKey: 'api-go', composePath: '/b/api-go/docker-compose.yml', relativePath: 'b/api-go/docker-compose.yml' },
    ];
    const readFile = async (p: string) => {
      if (p.includes('api-nest')) return 'ports:\n  - "${API_NEST_DEBUG_PORT:-9229}:9229"';
      if (p.includes('api-go')) return 'ports:\n  - "${API_GO_APP_PORT:-3001}:3001"';
      return '';
    };
    await assert.doesNotReject(validateHostPortConflicts(entries, readFile));
  });

  it('throws when two components use the same default host port', async () => {
    const entries: DiscoveryEntry[] = [
      { componentKey: 'api-nest', composePath: '/a/docker-compose.yml', relativePath: 'a/docker-compose.yml' },
      { componentKey: 'api-go', composePath: '/b/docker-compose.yml', relativePath: 'b/docker-compose.yml' },
    ];
    const readFile = async () => 'ports:\n  - "${SOME_PORT:-9229}:9229"';
    await assert.rejects(validateHostPortConflicts(entries, readFile), /Host port conflict/);
    await assert.rejects(validateHostPortConflicts(entries, readFile), /9229/);
  });
});

describe('collectLocalstackServicesFromInfra', () => {
  it('unions extras key from strategies and unique-sorts', () => {
    const infra = {
      default: {
        strategies: {
          localstack: {
            key: 'infra.aws.localstack',
            extras: { 'infra.aws.localstack.services': ['sns', 'sqs'] },
          },
        },
      },
    };
    const cdk = {
      extras: { 'infra.aws.localstack.services': ['s3', 'secretsmanager', 'sns'] },
    };
    const union = unionLocalstackServices([
      ...collectLocalstackServicesFromInfra(infra),
      ...collectLocalstackServicesFromInfra(cdk),
    ]);
    assert.strictEqual(union, 's3,secretsmanager,sns,sqs');
  });

  it('returns empty string when no extras present', () => {
    assert.strictEqual(unionLocalstackServices(collectLocalstackServicesFromInfra({})), '');
  });
});

