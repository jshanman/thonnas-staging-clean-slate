import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from '@jest/globals';
import { buildCdkApp } from './app-builder';
import { DependencyGraph, StrategyResolutionResult } from '../types';

const createTempRepo = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-cdk-builder-'));
  await fs.mkdir(path.join(dir, 'components', 'infra-cdk', 'generated'), { recursive: true });
  return dir;
};

describe('buildCdkApp', () => {
  const repos: string[] = [];

  afterEach(async () => {
    await Promise.all(repos.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('writes cdk-app.js with embedded payload', async () => {
    const repoRoot = await createTempRepo();
    repos.push(repoRoot);

    const runtimePath = path.join(repoRoot, 'runtime-stub.js');
    await fs.writeFile(runtimePath, 'module.exports = { createCdkApp: () => {} };');

    const graph: DependencyGraph = {
      environment: 'beta',
      nodes: [],
      edges: [],
    };

    const resolution: StrategyResolutionResult = {
      components: [],
      resources: [],
    };

    const appPath = await buildCdkApp({
      projectRoot: repoRoot,
      env: 'beta',
      graph,
      resolution,
      imageTag: 'latest',
      runtimeModulePathOverride: runtimePath,
    });

    const contents = await fs.readFile(appPath, 'utf8');
    expect(contents).toContain('createCdkApp');
    expect(contents).toContain('"env": "beta"');
  });
});




