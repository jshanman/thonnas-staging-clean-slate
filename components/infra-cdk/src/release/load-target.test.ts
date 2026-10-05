import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReleaseContext, findPackageDir, loadReleaseExtras } from './load-target';

function writePkg(dir: string, infra: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'thonnas-package.json'), JSON.stringify({ name: 'fixture-web', thonnas: { key: 'fixture-web' } }));
  fs.writeFileSync(path.join(dir, 'thonnas-infra.json'), JSON.stringify(infra, null, 2));
}

describe('load-target', () => {
  it('resolves components/<key> from projectRoot, not cwd', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-root-'));
    const pkg = path.join(root, 'components', 'fixture-web');
    writePkg(pkg, { default: { strategies: { website: { key: 'infra.website.static', extras: { outputPath: 'build' } } } } });
    const cwd = process.cwd();
    process.chdir(os.tmpdir());
    try {
      expect(findPackageDir(root, { targetComponent: 'fixture-web' })).toBe(pkg);
      expect(findPackageDir(root, { targetComponent: 'fixture-web' })).not.toBe(process.cwd());
    } finally {
      process.chdir(cwd);
    }
  });

  it('rejects more than one of target-component, lib, or module', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-exclusive-'));
    expect(() => findPackageDir(root, { targetComponent: 'fixture-web', lib: 'sdk-thonnas' })).toThrow(
      /only one of --target-component/,
    );
  });

  it('throws when the package is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-missing-'));
    expect(() => findPackageDir(root, { targetComponent: 'fixture-web' })).toThrow(/not found under components/);
  });

  it('prefers staging website.static over default simple-vm when both slots exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-web-simple-'));
    const pkg = path.join(root, 'components', 'web-angular');
    writePkg(pkg, {
      default: {
        strategies: {
          runtime: { key: 'infra.container.simple-vm', extras: { debugPort: 9229 } },
        },
      },
      staging: {
        strategies: {
          website: {
            key: 'infra.website.static',
            extras: {
              outputPath: 'dist',
              website_domain: '{env}.{component}.{rootDomain}',
              hosted_zone_domain: 'example.com',
            },
          },
        },
      },
    });
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.website.static');
    expect(loaded.extras?.outputPath).toBe('dist');
  });

  it('keeps website.static when staging only restates simple-vm on runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-web-shadow-'));
    const pkg = path.join(root, 'components', 'web-angular');
    writePkg(pkg, {
      default: {
        strategies: {
          runtime: { key: 'infra.container.simple-vm', extras: {} },
          website: { key: 'infra.website.static', extras: { outputPath: 'build' } },
        },
      },
      staging: {
        strategies: {
          runtime: { key: 'infra.container.simple-vm', extras: {} },
        },
      },
    });
    expect(loadReleaseExtras(pkg, 'staging').strategyKey).toBe('infra.website.static');
  });

  it('reads website extras and lets env overlay win', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-extras-'));
    const pkg = path.join(root, 'components', 'fixture-web');
    writePkg(pkg, {
      default: {
        strategies: {
          website: { key: 'infra.website.static', extras: { outputPath: 'build', bucket: 'default-bucket' } },
        },
      },
      staging: {
        strategies: {
          website: { key: 'infra.website.static', extras: { outputPath: 'out' } },
        },
      },
    });
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.website.static');
    expect(loaded.extras).toEqual({ outputPath: 'out', bucket: 'default-bucket' });
  });

  it('finds infra.website.static on a non-website slot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-slot-'));
    const pkg = path.join(root, 'components', 'fixture-web');
    writePkg(pkg, {
      default: {
        strategies: {
          runtime: { key: 'infra.container.managed-host', extras: {} },
          staticSite: { key: 'infra.website.static', extras: { outputPath: 'build' } },
        },
      },
    });
    expect(loadReleaseExtras(pkg, 'staging').strategyKey).toBe('infra.website.static');
  });

  it('resolves infra.db.relational from a database slot without website or runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-db-'));
    const pkg = path.join(root, 'components', 'fixture-db');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-db', thonnas: { key: 'fixture-db' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            database: { key: 'infra.db.relational', extras: { secretName: 'staging/fixture-db/postgres' } },
          },
        },
        staging: {
          strategies: {
            database: { key: 'infra.db.relational', extras: { secretName: 'staging/fixture-db/overlay' } },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.db.relational');
    expect(loaded.extras?.secretName).toBe('staging/fixture-db/overlay');
  });

  it('resolves infra.db.document from a database slot without website or runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-doc-'));
    const pkg = path.join(root, 'components', 'fixture-doc');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-doc', thonnas: { key: 'fixture-doc' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            database: { key: 'infra.db.document', extras: { secretName: 'staging/fixture-doc/docdb' } },
          },
        },
        staging: {
          strategies: {
            database: { key: 'infra.db.document', extras: { secretName: 'staging/fixture-doc/overlay' } },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.db.document');
    expect(loaded.extras?.secretName).toBe('staging/fixture-doc/overlay');
  });

  it('resolves infra.db.document from a document slot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-docslot-'));
    const pkg = path.join(root, 'components', 'fixture-doc');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-doc', thonnas: { key: 'fixture-doc' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            document: { key: 'infra.db.document', extras: { secretName: 'staging/fixture-doc/docdb' } },
          },
        },
      }),
    );
    expect(loadReleaseExtras(pkg, 'staging').strategyKey).toBe('infra.db.document');
  });

  it('resolves infra.cache.keyvalue from a cache slot without website or database', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-cache-'));
    const pkg = path.join(root, 'components', 'fixture-cache');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-cache', thonnas: { key: 'fixture-cache' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            cache: { key: 'infra.cache.keyvalue', extras: { secretName: 'staging/fixture-cache/redis' } },
          },
        },
        staging: {
          strategies: {
            cache: { key: 'infra.cache.keyvalue', extras: { secretName: 'staging/fixture-cache/overlay' } },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.cache.keyvalue');
    expect(loaded.extras?.secretName).toBe('staging/fixture-cache/overlay');
  });

  it('resolves infra.cache.keyvalue from a non-cache slot key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-cacheslot-'));
    const pkg = path.join(root, 'components', 'fixture-cache');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-cache', thonnas: { key: 'fixture-cache' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            runtime: { key: 'infra.cache.keyvalue', extras: { secretName: 'staging/fixture-cache/redis' } },
          },
        },
      }),
    );
    expect(loadReleaseExtras(pkg, 'staging').strategyKey).toBe('infra.cache.keyvalue');
  });

  it('resolves infra.container.managed-host from a runtime slot after cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-api-'));
    const pkg = path.join(root, 'components', 'fixture-api');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-api', thonnas: { key: 'fixture-api' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            runtime: { key: 'infra.container.managed-host', extras: { service: 'staging-fixture-api' } },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.container.managed-host');
    expect(loaded.extras?.service).toBe('staging-fixture-api');
  });

  it('resolves infra.worker.temporal from a worker slot after managed-host', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-temporal-'));
    const pkg = path.join(root, 'components', 'fixture-temporal');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-temporal', thonnas: { key: 'fixture-temporal' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            worker: { key: 'infra.worker.temporal', extras: { service: 'staging-fixture-temporal' } },
          },
        },
        staging: {
          strategies: {
            worker: { key: 'infra.worker.temporal', extras: { service: 'staging-fixture-temporal' } },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.worker.temporal');
    expect(loaded.extras?.service).toBe('staging-fixture-temporal');
  });

  it('resolves infra.container.managed-host from a temporal-ui runtime slot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-temporal-ui-'));
    const pkg = path.join(root, 'components', 'fixture-temporal-ui');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-temporal-ui', thonnas: { key: 'fixture-temporal-ui' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            runtime: { key: 'infra.container.managed-host', extras: { service: 'staging-fixture-temporal-ui' } },
          },
        },
        staging: {
          strategies: {
            runtime: { key: 'infra.container.managed-host', extras: { service: 'staging-fixture-temporal-ui' } },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.container.managed-host');
    expect(loaded.extras?.service).toBe('staging-fixture-temporal-ui');
  });

  it('prefers managed-host over temporal when both keys are present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-host-worker-'));
    const pkg = path.join(root, 'components', 'fixture-mixed');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-mixed', thonnas: { key: 'fixture-mixed' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            runtime: { key: 'infra.container.managed-host', extras: {} },
            worker: { key: 'infra.worker.temporal', extras: {} },
          },
        },
      }),
    );
    expect(loadReleaseExtras(pkg, 'staging').strategyKey).toBe('infra.container.managed-host');
  });

  it('resolves infra.observe.metrics from a metrics slot after temporal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-observe-'));
    const pkg = path.join(root, 'components', 'fixture-observe');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-observe', thonnas: { key: 'fixture-observe' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            metrics: { key: 'infra.observe.metrics', extras: {} },
            dashboard: { key: 'infra.observe.dashboard', extras: {} },
          },
        },
        staging: {
          strategies: {
            metrics: { key: 'infra.observe.metrics', extras: {} },
            dashboard: { key: 'infra.observe.dashboard', extras: {} },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.observe.metrics');
  });

  it('resolves infra.observe.dashboard when metrics is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-observe-dash-'));
    const pkg = path.join(root, 'components', 'fixture-observe');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-observe', thonnas: { key: 'fixture-observe' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            dashboard: { key: 'infra.observe.dashboard', extras: {} },
          },
        },
      }),
    );
    expect(loadReleaseExtras(pkg, 'staging').strategyKey).toBe('infra.observe.dashboard');
  });

  it('prefers temporal over observe when both keys are present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-worker-observe-'));
    const pkg = path.join(root, 'components', 'fixture-mixed');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-mixed', thonnas: { key: 'fixture-mixed' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            worker: { key: 'infra.worker.temporal', extras: {} },
            metrics: { key: 'infra.observe.metrics', extras: {} },
          },
        },
      }),
    );
    expect(loadReleaseExtras(pkg, 'staging').strategyKey).toBe('infra.worker.temporal');
  });

  it('prefers cache over managed-host when both keys are present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-mixed-'));
    const pkg = path.join(root, 'components', 'fixture-mixed');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-mixed', thonnas: { key: 'fixture-mixed' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            runtime: { key: 'infra.container.managed-host', extras: {} },
            cache: { key: 'infra.cache.keyvalue', extras: { secretName: 'staging/mixed/redis' } },
          },
        },
      }),
    );
    expect(loadReleaseExtras(pkg, 'staging').strategyKey).toBe('infra.cache.keyvalue');
  });


  it('resolves infra.artifact.deploy from an artifactDeploy slot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-art-'));
    const pkg = path.join(root, 'components', 'fixture-cli');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-cli', thonnas: { key: 'fixture-cli' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            artifactDeploy: { key: 'infra.artifact.deploy', extras: { outputPath: 'dist', bucket: 'cli-binaries' } },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'production');
    expect(loaded.strategyKey).toBe('infra.artifact.deploy');
    expect(loaded.extras?.bucket).toBe('cli-binaries');
  });

  it('resolves infra.api.storage-temp-url from a storageTempUrl slot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-sig-'));
    const pkg = path.join(root, 'components', 'fixture-signed-url');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-signed-url', thonnas: { key: 'fixture-signed-url' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            storageTempUrl: {
              key: 'infra.api.storage-temp-url',
              extras: { bucket: 'sig-bucket', outputPath: 'dist' },
            },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'production');
    expect(loaded.strategyKey).toBe('infra.api.storage-temp-url');
    expect(loaded.extras?.bucket).toBe('sig-bucket');
  });

  it('resolves infra.compute.fleet.mqtt from a "broker"-named slot (queue-mqtt\'s real shape)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-fleet-mqtt-'));
    const pkg = path.join(root, 'components', 'queue-mqtt');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'thonnas-package.json'), JSON.stringify({ name: 'queue-mqtt', thonnas: { key: 'queue-mqtt' } }));
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        staging: {
          strategies: {
            broker: { key: 'infra.compute.fleet.mqtt', extras: { bootstrapScript: 'bootstrap-emqx.sh' } },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.compute.fleet.mqtt');
    expect(loaded.extras?.bootstrapScript).toBe('bootstrap-emqx.sh');
  });

  it('resolves infra.compute.fleet.dba from a "store"-named slot (dba-clickhouse\'s real shape)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-fleet-dba-'));
    const pkg = path.join(root, 'components', 'dba-clickhouse');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'thonnas-package.json'), JSON.stringify({ name: 'dba-clickhouse', thonnas: { key: 'dba-clickhouse' } }));
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        staging: {
          strategies: {
            store: { key: 'infra.compute.fleet.dba', extras: { bootstrapScript: 'bootstrap-clickhouse.sh' } },
          },
        },
      }),
    );
    const loaded = loadReleaseExtras(pkg, 'staging');
    expect(loaded.strategyKey).toBe('infra.compute.fleet.dba');
  });

  it('buildReleaseContext uses flags for package identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-ctx-'));
    const pkg = path.join(root, 'components', 'fixture-web');
    writePkg(pkg, {
      default: { strategies: { website: { key: 'infra.website.static', extras: { outputPath: 'build' } } } },
    });
    const ctx = buildReleaseContext(root, 'staging', { targetComponent: 'fixture-web' });
    expect(ctx.packageDir).toBe(pkg);
    expect(ctx.strategyKey).toBe('infra.website.static');
    expect(ctx.projectRoot).toBe(root);
  });

  it('materializes hosted_zone_domain {rootDomain} from THONNAS_ROOT_DOMAIN', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-rootdomain-'));
    const pkg = path.join(root, 'components', 'web-angular');
    writePkg(pkg, {
      staging: {
        strategies: {
          staticSite: {
            key: 'infra.website.static',
            extras: {
              outputPath: 'dist/web-app/browser',
              website_domain: '{env}-{component}.{rootDomain}',
              hosted_zone_domain: '{rootDomain}',
            },
          },
        },
      },
    });
    const prev = process.env.THONNAS_ROOT_DOMAIN;
    process.env.THONNAS_ROOT_DOMAIN = 'ts1.parfiamlabs.com';
    try {
      const ctx = buildReleaseContext(root, 'staging', { targetComponent: 'web-angular' });
      expect(ctx.strategyKey).toBe('infra.website.static');
      expect(ctx.extras?.hosted_zone_domain).toBe('ts1.parfiamlabs.com');
      expect(ctx.extras?.rootDomain).toBe('ts1.parfiamlabs.com');
    } finally {
      if (prev === undefined) delete process.env.THONNAS_ROOT_DOMAIN;
      else process.env.THONNAS_ROOT_DOMAIN = prev;
    }
  });

  it('sets extras.projectName from THONNAS_PROJECT_NAME (fleetStackName/ecs-fargate release path depend on it)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-projectname-'));
    const pkg = path.join(root, 'components', 'dba-clickhouse');
    writePkg(pkg, {
      staging: {
        strategies: {
          store: { key: 'infra.compute.fleet.dba' },
        },
      },
    });
    const prev = process.env.THONNAS_PROJECT_NAME;
    process.env.THONNAS_PROJECT_NAME = 'TmpStagingCleanSlate';
    try {
      const ctx = buildReleaseContext(root, 'staging', { targetComponent: 'dba-clickhouse' });
      expect(ctx.strategyKey).toBe('infra.compute.fleet.dba');
      expect(ctx.extras?.projectName).toBe('TmpStagingCleanSlate');
    } finally {
      if (prev === undefined) delete process.env.THONNAS_PROJECT_NAME;
      else process.env.THONNAS_PROJECT_NAME = prev;
    }
  });

  it('sets extras.service to the collector family for observe metrics', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-obs-svc-'));
    const pkg = path.join(root, 'components', 'fixture-observe');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-observe', thonnas: { key: 'fixture-observe' } }),
    );
    fs.writeFileSync(
      path.join(pkg, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            metrics: { key: 'infra.observe.metrics', extras: {} },
          },
        },
      }),
    );
    const ctx = buildReleaseContext(root, 'staging', { targetComponent: 'fixture-observe' });
    expect(ctx.strategyKey).toBe('infra.observe.metrics');
    expect(ctx.extras?.service).toBe('staging-fixture-observe-collector');
  });

  it('sets extras.service to the dashboard family and leaves managed-host unsuffixed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-obs-dash-svc-'));
    const dash = path.join(root, 'components', 'fixture-dashboard');
    fs.mkdirSync(dash, { recursive: true });
    fs.writeFileSync(
      path.join(dash, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-dashboard', thonnas: { key: 'fixture-dashboard' } }),
    );
    fs.writeFileSync(
      path.join(dash, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            dashboard: { key: 'infra.observe.dashboard', extras: {} },
          },
        },
      }),
    );
    const dashCtx = buildReleaseContext(root, 'staging', { targetComponent: 'fixture-dashboard' });
    expect(dashCtx.extras?.service).toBe('staging-fixture-dashboard-dashboard');

    const api = path.join(root, 'components', 'fixture-api');
    fs.mkdirSync(api, { recursive: true });
    fs.writeFileSync(
      path.join(api, 'thonnas-package.json'),
      JSON.stringify({ name: 'fixture-api', thonnas: { key: 'fixture-api' } }),
    );
    fs.writeFileSync(
      path.join(api, 'thonnas-infra.json'),
      JSON.stringify({
        default: {
          strategies: {
            runtime: { key: 'infra.container.managed-host', extras: {} },
          },
        },
      }),
    );
    const apiCtx = buildReleaseContext(root, 'staging', { targetComponent: 'fixture-api' });
    expect(apiCtx.strategyKey).toBe('infra.container.managed-host');
    expect(apiCtx.extras?.service).toBeUndefined();
  });
});



