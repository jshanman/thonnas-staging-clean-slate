import fs from 'node:fs/promises';
import path from 'node:path';
import { DependencyGraph, StrategyResolutionResult } from '../types';
import type { ReleasedContainer } from '../stacks/released-container';
import { resolveRepoPath, sanitizeSegment } from '../utils/path-helpers';

export interface BuildCdkAppOptions {
  projectRoot: string;
  env: string;
  graph: DependencyGraph;
  resolution: StrategyResolutionResult;
  imageTag: string;
  gitTag?: string;
  deploySlug?: string;
  projectName?: string;
  accountId?: string;
  region?: string;
  rootDomain?: string;
  runtimeModulePathOverride?: string;
  releasedContainers?: Record<string, ReleasedContainer>;
}

const ensureRelativeRuntimePath = async (
  outputDir: string,
  projectRoot: string,
  override?: string,
): Promise<string> => {
  const runtimePath = override ?? path.resolve(projectRoot, 'components', 'infra-cdk', 'dist', 'cdk', 'runtime.js');
  try {
    await fs.access(runtimePath);
  } catch {
    throw new Error('CDK runtime missing. Run `npm run build` inside components/infra-cdk before planning/applying.');
  }
  const relative = path.relative(outputDir, runtimePath).replace(/\\/g, '/');
  if (!relative.startsWith('.')) {
    return `./${relative}`;
  }
  return relative;
};

// @intent Emit cdk-app.js that boots runtime with embedded graph/resolution
export const buildCdkApp = async (options: BuildCdkAppOptions): Promise<string> => {
  const envKey = sanitizeSegment(options.env) || options.env;
  const generatedDir = resolveRepoPath(options.projectRoot, 'components', 'infra-cdk', 'generated', envKey);
  await fs.mkdir(generatedDir, { recursive: true });

  const runtimeImportPath = await ensureRelativeRuntimePath(generatedDir, options.projectRoot, options.runtimeModulePathOverride);

  const copyToLatestHandlerEntry = path.resolve(
    options.projectRoot,
    'components',
    'infra-cdk',
    'src',
    'stacks',
    'copy-to-latest-handler.ts',
  );

  const payload = {
    graph: options.graph,
    resolution: options.resolution,
    imageTag: options.imageTag,
    gitTag: options.gitTag,
    deploySlug: options.deploySlug,
    projectName: options.projectName,
    accountId: options.accountId,
    region: options.region,
    rootDomain: options.rootDomain,
    env: envKey,
    projectRoot: path.resolve(options.projectRoot),
    copyToLatestHandlerEntry,
    releasedContainers: options.releasedContainers,
  };

  const fileContents = `'use strict';
const { createCdkApp, resolveGithubOidcProviderArnForSynth, resolveGithubNumericIdsForSynth } = require('${runtimeImportPath}');
const payload = ${JSON.stringify(payload, null, 2)};

(async () => {
  const existingProviderArn = await resolveGithubOidcProviderArnForSynth(payload);
  const { orgId: githubOrgId, repoId: githubRepoId } = await resolveGithubNumericIdsForSynth(payload);
  createCdkApp({ ...payload, existingProviderArn, githubOrgId, githubRepoId });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

  const outputPath = path.join(generatedDir, 'cdk-app.js');
  await fs.writeFile(outputPath, fileContents, 'utf8');
  return outputPath;
};




