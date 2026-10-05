import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { assertStacksSynthesized, synthesizedStackIds } from './cdk-manifest';

describe('cdk manifest checks', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  const writeManifest = async (artifacts: Record<string, { type: string }>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-cdk-manifest-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: '1', artifacts }));
    return dir;
  };

  it('lists only CloudFormation stack artifacts', async () => {
    const dir = await writeManifest({
      StagingNetworking: { type: 'aws:cloudformation:stack' },
      'StagingNetworking.assets': { type: 'cdk:asset-manifest' },
      Tree: { type: 'cdk:tree' },
    });
    expect([...(await synthesizedStackIds(dir))]).toEqual(['StagingNetworking']);
  });

  it('fails closed when a targeted stack was not synthesized', async () => {
    const dir = await writeManifest({
      StagingNetworking: { type: 'aws:cloudformation:stack' },
      StagingWiring: { type: 'aws:cloudformation:stack' },
    });
    await expect(
      assertStacksSynthesized(dir, ['Stagingworker-manager-temporalTemporal'], '--target-component worker-manager-temporal'),
    ).rejects.toThrow(/missing from the synthesized CDK app: Stagingworker-manager-temporalTemporal/);
    await expect(assertStacksSynthesized(dir, ['StagingWiring'], 'x')).resolves.toBeUndefined();
  });
});

