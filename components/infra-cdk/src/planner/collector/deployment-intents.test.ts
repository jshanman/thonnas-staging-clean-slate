import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeAll, jest } from '@jest/globals';
import { collectDeploymentIntents, _resetInfraGraphCliAvailabilityForTests } from './deployment-intents';

const createTempRepo = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-cdk-'));
  await fs.mkdir(path.join(dir, 'components'), { recursive: true });
  return dir;
};

const cleanupRepo = async (dir: string) => {
  await fs.rm(dir, { recursive: true, force: true });
};

describe('collectDeploymentIntents', () => {
  const repos: string[] = [];

  // @intent Never let this suite's timing/outcome depend on whatever `thonnas` binary happens
  // to be on the machine's PATH -- confirmed this is a real hazard, not hypothetical: upgrading
  // the local CLI build (adding the `infra graph` subcommand) turned loadInfraGraph's exec
  // fallback from an instant "unknown command" failure into a real, much slower invocation,
  // which alone was enough to blow past several of this file's test timeouts and race Windows
  // temp-dir cleanup (EBUSY). THONNAS_SKIP_INFRA_GRAPH_CLI short-circuits that fallback
  // entirely for test runs; production behavior (real `thonnas release`) is unaffected.
  beforeAll(() => {
    process.env.THONNAS_SKIP_INFRA_GRAPH_CLI = '1';
    _resetInfraGraphCliAvailabilityForTests();
  });

  afterEach(async () => {
    await Promise.all(repos.splice(0).map((dir) => cleanupRepo(dir)));
  });

  it('parses thonnas-infra.json and merges env overrides + secrets', async () => {
    const repoRoot = await createTempRepo();
    repos.push(repoRoot);

    const componentDir = path.join(repoRoot, 'components', 'api');
    await fs.mkdir(componentDir, { recursive: true });
    await fs.writeFile(
      path.join(componentDir, 'thonnas-infra.json'),
    JSON.stringify(
      {
        thonnasInfraVersion: 1,
        default: {
          domain: '{env}.{component}.example.local',
          strategies: {
            runtime: {
              key: 'infra.container.cluster',
              ports: [3000],
              secrets: [
                {
                  name: 'jwt',
                  description: 'JWT signing secret',
                },
              ],
            },
            database: {
              key: 'infra.db.relational',
              engine: 'postgres',
            },
          },
        },
        beta: {
          strategies: {
            runtime: {
              scaling: {
                min: 1,
                max: 2,
              },
            },
          },
        },
      },
      null,
      2,
    ),
    );

    const intents = await collectDeploymentIntents({
      env: 'beta',
      projectRoot: repoRoot,
    });

    expect(intents).toHaveLength(1);
    const intent = intents[0];
    expect(intent.component).toBe('api');
    expect(intent.domainPattern).toBe('{env}.{component}.example.local');
    expect(intent.strategies.runtime.ports).toEqual([3000]);
    expect(intent.environments.beta.runtime?.scaling).toEqual({ min: 1, max: 2 });
    expect(intent.requiredSecrets).toEqual([
      {
        name: 'jwt',
        scope: 'strategy',
        strategy: 'runtime',
        description: 'JWT signing secret',
        generator: 'random32',
      },
    ]);
  });

  it('excludes components with no strategies (endpoints-only infra files)', async () => {
    const repoRoot = await createTempRepo();
    repos.push(repoRoot);

    const componentDir = path.join(repoRoot, 'components', 'some-config-only');
    await fs.mkdir(componentDir, { recursive: true });
    await fs.writeFile(
      path.join(componentDir, 'thonnas-infra.json'),
      JSON.stringify({
        default: {},
        endpoints: {
          service: {
            default: { protocol: 'http', host: 'localhost', port: 8080 },
          },
        },
      }),
    );

    const intents = await collectDeploymentIntents({
      env: 'beta',
      projectRoot: repoRoot,
    });

    expect(intents).toHaveLength(0);
  });

  it('keeps non-target packages for dependency resolution and rejects unknown targets', async () => {
    const repoRoot = await createTempRepo();
    repos.push(repoRoot);
    const spec = {
      thonnasInfraVersion: 1,
      default: {
        strategies: {
          runtime: { key: 'infra.container.cluster', ports: [3000] },
        },
      },
    };
    for (const name of ['fixture-web', 'fixture-other']) {
      const dir = path.join(repoRoot, 'components', name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'thonnas-infra.json'), JSON.stringify(spec));
    }
    const intents = await collectDeploymentIntents({
      env: 'staging',
      projectRoot: repoRoot,
      targetComponents: ['fixture-web'],
    });
    // @intent planInfrastructure narrows to the target's closure; the collector must not drop providers
    expect(intents.map((i) => i.component)).toEqual(['fixture-other', 'fixture-web']);
    await expect(
      collectDeploymentIntents({
        env: 'staging',
        projectRoot: repoRoot,
        targetComponents: ['missing-app'],
      }),
    ).rejects.toThrow(/--target-component missing-app/);
  });

  describe('FEAT-011: fail-closed on dangling strategy resolutions', () => {
    const writeFixtureComponent = async (repoRoot: string, name: string) => {
      const dir = path.join(repoRoot, 'components', name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'thonnas-infra.json'),
        JSON.stringify({
          thonnasInfraVersion: 1,
          default: { strategies: { runtime: { key: 'infra.container.cluster', ports: [3000] } } },
        }),
      );
    };

    const writeStrategyMapping = async (repoRoot: string, resolvedTo: string) => {
      const dir = path.join(repoRoot, '.thonnas');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'strategy-mapping.json'),
        JSON.stringify({
          schemaVersion: '1',
          resolutions: [
            {
              strategy: 'database.transactional.document',
              consumer: 'fixture-web',
              purpose: 'ORDERS_PRIMARY_DOCUMENT_DB',
              resolvedTo,
              candidates: ['dbt-mongo', 'dbt-mongo-atlas'],
              resolvedBy: 'user',
              reasoning: 'test fixture',
              decidedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );
    };

    it('proceeds normally when the resolved component is still installed', async () => {
      const repoRoot = await createTempRepo();
      repos.push(repoRoot);
      await writeFixtureComponent(repoRoot, 'fixture-web');
      await writeFixtureComponent(repoRoot, 'dbt-mongo');
      await writeStrategyMapping(repoRoot, 'dbt-mongo');

      const intents = await collectDeploymentIntents({ env: 'staging', projectRoot: repoRoot });

      expect(intents.map((i) => i.component).sort()).toEqual(['dbt-mongo', 'fixture-web']);
    });

    it('throws a clear error when the resolved component is no longer installed', async () => {
      const repoRoot = await createTempRepo();
      repos.push(repoRoot);
      await writeFixtureComponent(repoRoot, 'fixture-web');
      // "dbt-mongo" is never installed in this repo.
      await writeStrategyMapping(repoRoot, 'dbt-mongo');

      await expect(collectDeploymentIntents({ env: 'staging', projectRoot: repoRoot })).rejects.toThrow(
        /dbt-mongo.*no longer installed|no longer installed.*dbt-mongo/is,
      );
    });

    it('is a no-op when no strategy-mapping.json exists', async () => {
      const repoRoot = await createTempRepo();
      repos.push(repoRoot);
      await writeFixtureComponent(repoRoot, 'fixture-web');

      await expect(collectDeploymentIntents({ env: 'staging', projectRoot: repoRoot })).resolves.toHaveLength(1);
    });
  });

  describe('dependency-aware release ordering', () => {
    const writeFixtureComponent = async (repoRoot: string, name: string) => {
      const dir = path.join(repoRoot, 'components', name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'thonnas-infra.json'),
        JSON.stringify({
          thonnasInfraVersion: 1,
          default: { strategies: { runtime: { key: 'infra.container.cluster', ports: [3000] } } },
        }),
      );
    };

    const writeInfraGraph = async (repoRoot: string, env: string, edges: Record<string, unknown>[]) => {
      const dir = path.join(repoRoot, 'project', 'generated');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `infra-graph.${env}.json`),
        JSON.stringify({ schemaVersion: '1', env, nodes: [], edges, unresolved: [], portConflicts: [] }),
      );
    };

    it('sorts a dependency before its consumer when the graph records a config-import edge, overriding alphabetical order', async () => {
      const repoRoot = await createTempRepo();
      repos.push(repoRoot);
      // @intent Alphabetically, "api-go" sorts before "queue-mqtt" -- without the graph, release
      // would hit api-go first and crash-loop against a broker that isn't up yet.
      await writeFixtureComponent(repoRoot, 'api-go');
      await writeFixtureComponent(repoRoot, 'queue-mqtt');
      await writeInfraGraph(repoRoot, 'staging', [
        { from: 'api-go', to: 'queue-mqtt', strategy: 'direct-reference', purpose: 'QUEUE_MQTT_INTERNAL_HOST', resolvedVia: 'unambiguous', source: 'config-import-key' },
      ]);

      const intents = await collectDeploymentIntents({ env: 'staging', projectRoot: repoRoot });

      expect(intents.map((i) => i.component)).toEqual(['queue-mqtt', 'api-go']);
    });

    it('falls back to alphabetical order and warns, without throwing, when the graph has a real dependency cycle', async () => {
      const repoRoot = await createTempRepo();
      repos.push(repoRoot);
      await writeFixtureComponent(repoRoot, 'a-service');
      await writeFixtureComponent(repoRoot, 'b-service');
      await writeInfraGraph(repoRoot, 'staging', [
        { from: 'a-service', to: 'b-service', strategy: 'direct-reference', purpose: 'X', resolvedVia: 'unambiguous', source: 'config-import-key' },
        { from: 'b-service', to: 'a-service', strategy: 'direct-reference', purpose: 'Y', resolvedVia: 'unambiguous', source: 'config-import-key' },
      ]);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const intents = await collectDeploymentIntents({ env: 'staging', projectRoot: repoRoot });

      expect(intents.map((i) => i.component)).toEqual(['a-service', 'b-service']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Dependency cycle detected'));
      warnSpy.mockRestore();
    });

    it('falls back to alphabetical order when no infra-graph file exists and the CLI has no "infra graph" command', async () => {
      const repoRoot = await createTempRepo();
      repos.push(repoRoot);
      await writeFixtureComponent(repoRoot, 'zeta');
      await writeFixtureComponent(repoRoot, 'alpha');

      const intents = await collectDeploymentIntents({ env: 'staging', projectRoot: repoRoot });

      expect(intents.map((i) => i.component)).toEqual(['alpha', 'zeta']);
    });

    it('ignores a self-loop edge without affecting order', async () => {
      const repoRoot = await createTempRepo();
      repos.push(repoRoot);
      await writeFixtureComponent(repoRoot, 'alpha');
      await writeFixtureComponent(repoRoot, 'zeta');
      await writeInfraGraph(repoRoot, 'staging', [
        { from: 'alpha', to: 'alpha', strategy: 'architecture.contracts.portable', purpose: 'architecture.contracts.portable', resolvedVia: 'unambiguous', source: 'requires-strategies' },
      ]);

      const intents = await collectDeploymentIntents({ env: 'staging', projectRoot: repoRoot });

      expect(intents.map((i) => i.component)).toEqual(['alpha', 'zeta']);
    });
  });
});





