import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach } from '@jest/globals';
import { createFileSecretsProvider } from './file-secrets-provider';

describe('FileSecretsProvider', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-cdk-secrets-'));
  });

  it('persists generated secrets and reuses existing ones', async () => {
    const provider = createFileSecretsProvider({ projectRoot: repoRoot, env: 'beta' });
    const pathA = 'thonnas/beta/api/jwt';
    const first = await provider.ensureSecret(pathA, () => 'generated-secret');
    expect(first).toBe('generated-secret');

    const second = await provider.ensureSecret(pathA);
    expect(second).toBe('generated-secret');

    const secretsFile = await fs.readFile(path.join(repoRoot, '.thonnas', 'secrets', '.env.beta'), 'utf8');
    expect(secretsFile).toContain('THONNAS_BETA_API_JWT=generated-secret');
  });
});




