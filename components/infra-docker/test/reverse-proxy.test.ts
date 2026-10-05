// @intent Test reverse-proxy generation: routes and depends_on derived from components with _EXTERNAL_HOST/_HOST
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildReverseProxyRoutes,
  getDependsOnFromRoutes,
  type ComponentInfra,
  type DiscoveryEntry,
} from '../scripts/lib/reverse-proxy.js';

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

function mkInfra(envVar: string, host: string, port: number, websocket = false): ComponentInfra {
  return {
    default: {
      derivations: [{ name: envVar }],
      endpoints: {
        internal: {
          default: {
            host,
            port,
            protocol: websocket ? 'ws' : 'http',
            tags: websocket ? ['websocket'] : [],
          },
        },
      },
    },
  };
}

describe('buildReverseProxyRoutes', () => {
  it('returns routes only for components with _EXTERNAL_HOST or _HOST derivations', () => {
    const entries: DiscoveryEntry[] = [
      mkEntry('api-nest'),
      mkEntry('cache-redis'),
      mkEntry('web-angular'),
    ];
    const infraByKey = new Map<string, ComponentInfra>([
      ['api-nest', mkInfra('API_NEST_EXTERNAL_HOST', 'api-nest', 3000)],
      ['cache-redis', mkInfra('METRICS_OTEL_SIGNOZ_HOST', 'signoz', 3301)],
      ['web-angular', mkInfra('WEB_ANGULAR_EXTERNAL_HOST', 'web-angular', 4200)],
    ]);
    const routes = buildReverseProxyRoutes(entries, infraByKey);
    assert.strictEqual(routes.length, 3, 'all three have _EXTERNAL_HOST or _HOST derivations');
    assert.deepStrictEqual(
      routes.map((r) => r.envVar).sort(),
      ['API_NEST_EXTERNAL_HOST', 'METRICS_OTEL_SIGNOZ_HOST', 'WEB_ANGULAR_EXTERNAL_HOST'],
    );
  });

  it('skips components without external host derivation', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest'), mkEntry('cache-redis')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['api-nest', mkInfra('API_NEST_EXTERNAL_HOST', 'api-nest', 3000)],
      ['cache-redis', { default: { derivations: [{ name: 'CACHE_REDIS_INTERNAL_HOST' }] } }],
    ]);
    const routes = buildReverseProxyRoutes(entries, infraByKey);
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].envVar, 'API_NEST_EXTERNAL_HOST');
    assert.strictEqual(routes[0].upstream, 'api-nest:3000');
  });

  it('skips components without internal endpoint', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['api-nest', { default: { derivations: [{ name: 'API_NEST_EXTERNAL_HOST' }] } }],
    ]);
    const routes = buildReverseProxyRoutes(entries, infraByKey);
    assert.strictEqual(routes.length, 0);
  });

  it('detects websocket endpoints via tags and protocol', () => {
    const entries: DiscoveryEntry[] = [mkEntry('queue-mqtt')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['queue-mqtt', mkInfra('QUEUE_MQTT_EXTERNAL_HOST', 'queue-mqtt', 1883, true)],
    ]);
    const routes = buildReverseProxyRoutes(entries, infraByKey);
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].websocket, true);
  });

  it('returns env and upstream for each route', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['api-nest', mkInfra('API_NEST_EXTERNAL_HOST', 'api-nest', 3000)],
    ]);
    const routes = buildReverseProxyRoutes(entries, infraByKey);
    assert.deepStrictEqual(routes[0], {
      envVar: 'API_NEST_EXTERNAL_HOST',
      upstream: 'api-nest:3000',
      websocket: false,
      componentKey: 'api-nest',
    });
  });

  it('emits multiple routes per component when external has roleKeyed (e.g. primary + dashboard)', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-growthbook')];
    const infraByKey = new Map<string, ComponentInfra>([
      [
        'api-growthbook',
        {
          default: {
            derivations: [
              { name: 'API_GROWTHBOOK_API_EXTERNAL_HOST' },
              { name: 'API_GROWTHBOOK_DASHBOARD_EXTERNAL_HOST' },
            ],
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
    const routes = buildReverseProxyRoutes(entries, infraByKey, 'beta');
    assert.strictEqual(routes.length, 2, 'primary and dashboard routes');
    const primaryRoute = routes.find((r) => r.upstream === 'api-growthbook:3100');
    const dashboardRoute = routes.find((r) => r.upstream === 'api-growthbook:3000');
    assert.ok(primaryRoute, 'primary route exists');
    assert.ok(dashboardRoute, 'dashboard route exists');
    assert.strictEqual(primaryRoute!.defaultHost, '{env}.growthbook.{rootDomain}');
    assert.strictEqual(dashboardRoute!.defaultHost, '{env}.growthbook-dashboard.{rootDomain}');
  });

  it('uses the graph-resolved serviceName as the upstream host when an instanceKey map is provided', () => {
    const entries: DiscoveryEntry[] = [mkAliasedEntry('cache-redis', 'cache-redis::a')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['cache-redis', mkInfra('CACHE_REDIS_EXTERNAL_HOST', 'cache-redis', 6379)],
    ]);
    const serviceNameByInstanceKey = new Map([['cache-redis::a', 'cache-redis-a']]);
    const routes = buildReverseProxyRoutes(entries, infraByKey, undefined, serviceNameByInstanceKey);
    assert.strictEqual(routes[0].upstream, 'cache-redis-a:6379');
  });

  it('distinguishes two aliased instances with different upstreams instead of colliding on the declared host', () => {
    const entries: DiscoveryEntry[] = [
      mkAliasedEntry('cache-redis', 'cache-redis::a'),
      mkAliasedEntry('cache-redis', 'cache-redis::b'),
    ];
    const infraByKey = new Map<string, ComponentInfra>([
      ['cache-redis', mkInfra('CACHE_REDIS_EXTERNAL_HOST', 'cache-redis', 6379)],
    ]);
    const serviceNameByInstanceKey = new Map([
      ['cache-redis::a', 'cache-redis-a'],
      ['cache-redis::b', 'cache-redis-b'],
    ]);
    const routes = buildReverseProxyRoutes(entries, infraByKey, undefined, serviceNameByInstanceKey);
    assert.deepStrictEqual(routes.map((r) => r.upstream).sort(), ['cache-redis-a:6379', 'cache-redis-b:6379']);
  });

  it('falls back to the declared host when the entry has no instanceKey, even with a map present', () => {
    const entries: DiscoveryEntry[] = [mkEntry('api-nest')];
    const infraByKey = new Map<string, ComponentInfra>([
      ['api-nest', mkInfra('API_NEST_EXTERNAL_HOST', 'api-nest', 3000)],
    ]);
    const serviceNameByInstanceKey = new Map([['api-nest::other', 'irrelevant']]);
    const routes = buildReverseProxyRoutes(entries, infraByKey, undefined, serviceNameByInstanceKey);
    assert.strictEqual(routes[0].upstream, 'api-nest:3000');
  });

  it('resolves the roleKeyed upstream via the graph too (primary + dashboard)', () => {
    const entries: DiscoveryEntry[] = [mkAliasedEntry('api-growthbook', 'api-growthbook::a')];
    const infraByKey = new Map<string, ComponentInfra>([
      [
        'api-growthbook',
        {
          default: {
            derivations: [
              { name: 'API_GROWTHBOOK_API_EXTERNAL_HOST' },
              { name: 'API_GROWTHBOOK_DASHBOARD_EXTERNAL_HOST' },
            ],
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
    const serviceNameByInstanceKey = new Map([['api-growthbook::a', 'api-growthbook-a']]);
    const routes = buildReverseProxyRoutes(entries, infraByKey, 'beta', serviceNameByInstanceKey);
    assert.deepStrictEqual(
      routes.map((r) => r.upstream).sort(),
      ['api-growthbook-a:3100', 'api-growthbook-a:3000'].sort(),
    );
  });
});

describe('getDependsOnFromRoutes', () => {
  it('derives service names from route upstreams (host:port)', () => {
    const routes = [
      { envVar: 'API_NEST_EXTERNAL_HOST', upstream: 'api-nest:3000', websocket: false },
      { envVar: 'WEB_ANGULAR_EXTERNAL_HOST', upstream: 'web-angular:4200', websocket: false },
    ];
    const dependsOn = getDependsOnFromRoutes(routes);
    assert.deepStrictEqual(dependsOn, ['api-nest', 'web-angular']);
  });

  it('returns empty array when no routes', () => {
    const dependsOn = getDependsOnFromRoutes([]);
    assert.deepStrictEqual(dependsOn, []);
  });

  it('matches env vars: depends_on is same services that get env vars', () => {
    const routes = [
      { envVar: 'API_GO_EXTERNAL_HOST', upstream: 'api-go:8080', websocket: false },
      { envVar: 'QUEUE_MQTT_EXTERNAL_HOST', upstream: 'queue-mqtt:1883', websocket: true },
    ];
    const dependsOn = getDependsOnFromRoutes(routes);
    const envVarServices = ['api-go', 'queue-mqtt'];
    assert.deepStrictEqual(dependsOn, envVarServices);
  });
});

