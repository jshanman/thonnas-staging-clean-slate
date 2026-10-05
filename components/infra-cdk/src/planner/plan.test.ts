import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from '@jest/globals';
import { formatPlanSummaryLines, planInfrastructure } from './plan';
import { selectTargetStackIds } from './stack-status';
import { createCdkApp } from '../cdk/runtime';

const createRepo = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-cdk-plan-'));
  await fs.mkdir(path.join(dir, 'components', 'api-web'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'components', 'api-web', 'thonnas-infra.json'),
    JSON.stringify(
      {
        thonnasInfraVersion: 1,
        default: {
          strategies: {
            runtime: {
              key: 'infra.container.simple-vm',
              ports: [8080],
              exposed: true,
              secrets: [{ name: 'api-key' }],
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return dir;
};

const cleanup = async (dir: string) => {
  await fs.rm(dir, { recursive: true, force: true });
};

describe('planInfrastructure', () => {
  const repos: string[] = [];

  afterEach(async () => {
    await Promise.all(repos.splice(0).map((dir) => cleanup(dir)));
  });

  it('produces resolved intents, ensures secrets, and writes debug output', async () => {
    const repoRoot = await createRepo();
    repos.push(repoRoot);

    const runtimeDir = path.join(repoRoot, 'components', 'infra-cdk', 'dist', 'cdk');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'runtime.js'), 'module.exports = { createCdkApp: () => {} };');

    const result = await planInfrastructure({
      env: 'beta',
      projectRoot: repoRoot,
      rootDomain: 'example.local',
      cdkRuntimeModulePathOverride: path.join(runtimeDir, 'runtime.js'),
    });

    expect(result.resolvedIntents).toHaveLength(1);
    const [intent] = result.resolvedIntents;
    expect(intent.domain).toBe('beta.api-web.example.local');
    expect(result.secrets).toEqual([
      {
        component: 'api-web',
        strategy: 'runtime',
        path: 'thonnas/beta/api-web/api-key',
      },
    ]);
    const debugJson = await fs.readFile(result.outputPath, 'utf8');
    const payload = JSON.parse(debugJson);
    expect(payload[0].requiredSecrets[0].value).toBe('***managed***');

    expect(result.strategyResolution.components).toHaveLength(1);
    expect(result.dependencyGraph.nodes.length).toBeGreaterThan(0);
    expect(result.graphOutputPath).toContain('dependency-graph.json');
    const graphJson = await fs.readFile(result.graphOutputPath, 'utf8');
    const graphPayload = JSON.parse(graphJson);
    expect(graphPayload.nodes.length).toBeGreaterThan(0);
  });

  it('prioritizes monorepo deploy intent for target env', async () => {
    const repoRoot = await createRepo();
    repos.push(repoRoot);

    await fs.mkdir(path.join(repoRoot, 'components', 'infra-docker'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'components', 'infra-docker', 'thonnas-infra.json'),
      JSON.stringify(
        {
          thonnasInfraVersion: 1,
          default: {
            strategies: {
              composeHost: {
                key: 'infra.container.compose-host',
                extras: {
                  monorepoDeploy: true,
                  gitRepositoryUrl: 'https://github.com/example/project.git',
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const runtimeDir = path.join(repoRoot, 'components', 'infra-cdk', 'dist', 'cdk');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'runtime.js'), 'module.exports = { createCdkApp: () => {} };');

    const result = await planInfrastructure({
      env: 'beta',
      projectRoot: repoRoot,
      rootDomain: 'example.local',
      cdkRuntimeModulePathOverride: path.join(runtimeDir, 'runtime.js'),
    });

    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].component).toBe('infra-docker');
    expect(result.strategyResolution.components).toHaveLength(1);
  });

  it('does not block first create of a protected relational store', async () => {
    const repoRoot = await createRepo();
    repos.push(repoRoot);
    await fs.mkdir(path.join(repoRoot, 'components', 'fixture-db'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'components', 'fixture-db', 'thonnas-infra.json'),
      JSON.stringify(
        {
          thonnasInfraVersion: 1,
          default: {
            strategies: {
              database: {
                key: 'infra.db.relational',
                engine: 'postgres',
                extras: { reliability: 'standard' },
              },
            },
          },
        },
        null,
        2,
      ),
    );
    const runtimeDir = path.join(repoRoot, 'components', 'infra-cdk', 'dist', 'cdk');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'runtime.js'), 'module.exports = { createCdkApp: () => {} };');

    const result = await planInfrastructure({
      env: 'staging',
      projectRoot: repoRoot,
      rootDomain: 'example.local',
      cdkRuntimeModulePathOverride: path.join(runtimeDir, 'runtime.js'),
    });
    expect(result.strategyResolution.components.some((c) => c.construct === 'RdsPostgresInstance')).toBe(true);
    const rdsRow = result.stackRows.find((row) => row.family === 'rds');
    expect(rdsRow?.status).toBe('create');
  });

  it('blocks engine change on an existing protected relational store', async () => {
    const repoRoot = await createRepo();
    repos.push(repoRoot);
    await fs.mkdir(path.join(repoRoot, 'components', 'fixture-db'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'components', 'fixture-db', 'thonnas-infra.json'),
      JSON.stringify(
        {
          thonnasInfraVersion: 1,
          default: {
            strategies: {
              database: {
                key: 'infra.db.relational',
                engine: 'mysql',
                extras: { reliability: 'standard', appliedEngine: 'postgres' },
              },
            },
          },
        },
        null,
        2,
      ),
    );
    const runtimeDir = path.join(repoRoot, 'components', 'infra-cdk', 'dist', 'cdk');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'runtime.js'), 'module.exports = { createCdkApp: () => {} };');

    const first = await planInfrastructure({
      env: 'staging',
      projectRoot: repoRoot,
      rootDomain: 'example.local',
      cdkRuntimeModulePathOverride: path.join(runtimeDir, 'runtime.js'),
    });
    const rdsId = first.stackRows.find((row) => row.family === 'rds')?.stackId;
    expect(rdsId).toBeTruthy();
    const result = await planInfrastructure({
      env: 'staging',
      projectRoot: repoRoot,
      rootDomain: 'example.local',
      cdkRuntimeModulePathOverride: path.join(runtimeDir, 'runtime.js'),
      existingState: { existingStackNames: [rdsId!] },
    });
    const rdsRow = result.stackRows.find((row) => row.family === 'rds');
    expect(rdsRow?.status).toBe('blocked');
    expect(rdsRow?.reason).toMatch(/engine postgres → mysql/);
    expect(formatPlanSummaryLines(result.stackRows).join('\n')).toMatch(/blocked/);
  });

  it('imports an artifact row when resolveBucketExists reports the bucket', async () => {
    const repoRoot = await createRepo();
    repos.push(repoRoot);
    await fs.mkdir(path.join(repoRoot, 'components', 'fixture-artifact'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'components', 'fixture-artifact', 'thonnas-infra.json'),
      JSON.stringify(
        {
          thonnasInfraVersion: 1,
          default: {
            strategies: {
              artifact: {
                key: 'infra.artifact.deploy',
                extras: { bucket: 'p5-review-bucket', prefix: 'staging', artifactPath: 'payload/app.bin' },
              },
            },
          },
        },
        null,
        2,
      ),
    );
    const runtimeDir = path.join(repoRoot, 'components', 'infra-cdk', 'dist', 'cdk');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'runtime.js'), 'module.exports = { createCdkApp: () => {} };');

    const result = await planInfrastructure({
      env: 'staging',
      projectRoot: repoRoot,
      rootDomain: 'example.local',
      cdkRuntimeModulePathOverride: path.join(runtimeDir, 'runtime.js'),
      resolveBucketExists: async (names) => {
        expect(names).toContain('p5-review-bucket');
        return { 'p5-review-bucket': true };
      },
    });
    expect(result.stackRows.find((row) => row.family === 'artifact')?.status).toBe('import');
  });

  // @intent Mirror the e2e repo: Temporal gets its Postgres from a sibling package
  const writeInfra = async (repoRoot: string, name: string, staging: Record<string, unknown>) => {
    await fs.mkdir(path.join(repoRoot, 'components', name), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'components', name, 'thonnas-infra.json'),
      JSON.stringify({ thonnasInfraVersion: 1, default: {}, staging: { strategies: staging } }, null, 2),
    );
  };

  const stubRuntime = async (repoRoot: string) => {
    const runtimeDir = path.join(repoRoot, 'components', 'infra-cdk', 'dist', 'cdk');
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, 'runtime.js'), 'module.exports = { createCdkApp: () => {} };');
    return path.join(runtimeDir, 'runtime.js');
  };

  it('--target-component resolves consumed providers so the target stack is synthesized', async () => {
    const repoRoot = await createRepo();
    repos.push(repoRoot);
    await writeInfra(repoRoot, 'dbt-postgres', {
      relational: { key: 'infra.db.relational', engine: 'postgres', extras: { engine: 'postgres' } },
    });
    await writeInfra(repoRoot, 'worker-manager-temporal', {
      worker: { key: 'infra.worker.temporal', ports: [7233] },
    });

    const result = await planInfrastructure({
      env: 'staging',
      projectRoot: repoRoot,
      rootDomain: 'example.local',
      accountId: '123456789012',
      region: 'us-east-1',
      cdkRuntimeModulePathOverride: await stubRuntime(repoRoot),
      targetComponents: ['worker-manager-temporal'],
    });

    // Unrelated api-web is dropped; the RDS provider is kept as a dependency
    expect(result.intents.map((i) => i.component).sort()).toEqual(['dbt-postgres', 'worker-manager-temporal']);
    const temporalRow = result.stackRows.find((row) => row.family === 'temporal');
    expect(temporalRow?.status).toBe('create');
    expect(temporalRow?.components).toEqual(['worker-manager-temporal']);

    // The target's own stack is deployed; RDS is synthesized but not deployed (not a dependency
    // of the target being changed here), but foundational Networking/Wiring always deploy
    // alongside any target so they never silently drift from what CDK's cross-stack references expect.
    const targetIds = selectTargetStackIds(result.stackRows, ['worker-manager-temporal'], 'deploy');
    expect(targetIds).toContain(temporalRow!.stackId);
    expect(targetIds).not.toContain(result.stackRows.find((row) => row.family === 'rds')?.stackId);
    expect(targetIds).toEqual(
      expect.arrayContaining(
        result.stackRows.filter((row) => row.family === 'networking' || row.family === 'wiring').map((row) => row.stackId),
      ),
    );

    // The real runtime emits that stack from the same resolution
    const app = createCdkApp({
      env: 'staging',
      graph: result.dependencyGraph,
      resolution: result.strategyResolution,
      imageTag: 'latest',
      accountId: '123456789012',
      region: 'us-east-1',
    });
    expect(app.node.tryFindChild(temporalRow!.stackId)).toBeDefined();
  });

  it('--target-component fails closed when the target stack would be blocked', async () => {
    const repoRoot = await createRepo();
    repos.push(repoRoot);
    await writeInfra(repoRoot, 'worker-manager-temporal', {
      worker: { key: 'infra.worker.temporal', ports: [7233] },
    });

    const result = await planInfrastructure({
      env: 'staging',
      projectRoot: repoRoot,
      rootDomain: 'example.local',
      cdkRuntimeModulePathOverride: await stubRuntime(repoRoot),
      targetComponents: ['worker-manager-temporal'],
    });

    // Shared rows alone must not count as success for the target
    expect(result.stackRows.some((row) => row.family === 'networking' && row.status !== 'blocked')).toBe(true);
    expect(() => selectTargetStackIds(result.stackRows, ['worker-manager-temporal'], 'deploy')).toThrow(
      /--target-component worker-manager-temporal produced no deployable stacks; blocked: .*Temporal \(blocked: temporal requires infra.db.relational/,
    );
  });
});

