import fs from 'node:fs/promises';
import path from 'node:path';

// @intent List CloudFormation stack ids a cdk.out assembly actually synthesized
export async function synthesizedStackIds(cdkOutDir: string): Promise<Set<string>> {
  const raw = await fs.readFile(path.join(cdkOutDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw) as { artifacts?: Record<string, { type?: string }> };
  return new Set(
    Object.entries(manifest.artifacts ?? {})
      .filter(([, artifact]) => artifact?.type === 'aws:cloudformation:stack')
      .map(([id]) => id),
  );
}

// @intent Fail closed when a targeted stack id is absent from the synthesized app
export async function assertStacksSynthesized(cdkOutDir: string, stackIds: string[], label: string): Promise<void> {
  const present = await synthesizedStackIds(cdkOutDir);
  const missing = stackIds.filter((id) => !present.has(id));
  if (missing.length) {
    throw new Error(`${label}: stacks missing from the synthesized CDK app: ${missing.join(', ')}`);
  }
}

