/**
 * @intent Collect infra.storage strategy bucket names and planned resources from component thonnas-infra for a given env.
 * Used by plan (to show S3 buckets to create) and by compose-host config builder (to set s3StorageBucketNames).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PlannedResource } from '../types';

const INFRA_STORAGE_KEY = 'infra.storage';

/** One component dir -> one thonnas-infra (prefer generated/ over root). */
async function collectInfraFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      const nested = await collectInfraFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile() && entry.name === 'thonnas-infra.json') {
      files.push(fullPath);
    }
  }
  const byComponentDir = new Map<string, string>();
  const normalized = (p: string) => p.replace(/\\/g, '/');
  for (const f of files) {
    const dirOfFile = path.dirname(f);
    const componentDir = normalized(dirOfFile).endsWith('/generated')
      ? path.dirname(dirOfFile)
      : dirOfFile;
    const existing = byComponentDir.get(componentDir);
    const isGenerated = normalized(f).includes('/generated/');
    if (!existing || (isGenerated && !normalized(existing).includes('/generated/'))) {
      byComponentDir.set(componentDir, f);
    }
  }
  return Array.from(byComponentDir.values());
}

function substituteEnv(value: string, env: string): string {
  return value.replaceAll('{env}', env);
}

export interface StorageStrategyResult {
  bucketNames: string[];
  plannedResources: PlannedResource[];
}

/**
 * @intent Scan components under projectRoot for thonnas-infra; for env, collect infra.storage bucket names and planned resources.
 */
export async function collectS3StorageFromProject(
  projectRoot: string,
  env: string,
): Promise<StorageStrategyResult> {
  const componentsDir = path.join(projectRoot, 'components');
  let infraPaths: string[] = [];
  try {
    await fs.access(componentsDir);
    infraPaths = await collectInfraFiles(componentsDir);
  } catch {
    return { bucketNames: [], plannedResources: [] };
  }

  const bucketNames: string[] = [];
  const plannedResources: PlannedResource[] = [];
  const seen = new Set<string>();

  for (const infraPath of infraPaths) {
    const dirOfFile = path.dirname(infraPath);
    const componentDir =
      path.basename(dirOfFile) === 'generated' ? path.dirname(dirOfFile) : dirOfFile;
    const componentName = path.basename(componentDir);

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await fs.readFile(infraPath, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    const environments = raw.environments as Record<string, Record<string, unknown>> | undefined;
    if (!environments?.[env]) continue;

    const strategies = environments[env].strategies as Record<string, Record<string, unknown>> | undefined;
    const storage = strategies?.storage as Record<string, unknown> | undefined;
    if (!storage || storage.key !== INFRA_STORAGE_KEY) continue;

    const bucket = storage.bucket as string | undefined;
    if (!bucket || typeof bucket !== 'string') continue;

    const resolvedBucket = substituteEnv(bucket, env);
    if (!seen.has(resolvedBucket)) {
      seen.add(resolvedBucket);
      bucketNames.push(resolvedBucket);
      plannedResources.push({
        id: `s3-storage-${componentName}-${env}`,
        kind: 's3StorageBucket',
        env,
        scope: 'service',
        component: componentName,
        props: { bucketName: resolvedBucket },
      });
    }
  }

  return { bucketNames, plannedResources };
}



