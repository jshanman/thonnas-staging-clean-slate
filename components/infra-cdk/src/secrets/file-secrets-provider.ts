import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { SecretsProvider, SecretsProviderFactoryOptions } from './secrets-provider';
import { resolveRepoPath, secretPathToKey } from '../utils/path-helpers';

interface EnvFileEntry {
  key: string;
  value: string;
}

// @intent Provide file-backed secrets with lazy generation + persistence
class FileSecretsProvider implements SecretsProvider {
  private readonly secretsDir: string;

  private readonly envFile: string;

  private initialized = false;

  private cache = new Map<string, string>();

  constructor(private readonly options: SecretsProviderFactoryOptions) {
    this.secretsDir = resolveRepoPath(options.projectRoot, '.thonnas', 'secrets');
    this.envFile = path.join(this.secretsDir, `.env.${options.env}`);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.secretsDir, { recursive: true });
    try {
      const file = await fs.readFile(this.envFile, 'utf8');
      file
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .forEach((line) => {
          const [rawKey, ...rest] = line.split('=');
          if (!rawKey) return;
          const key = rawKey.trim();
          const value = rest.join('=').trim();
          if (key && value) {
            this.cache.set(key, value);
          }
        });
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT')) {
        throw error;
      }
    }
    this.initialized = true;
  }

  private async persist(): Promise<void> {
    const entries: EnvFileEntry[] = Array.from(this.cache.entries()).map(([key, value]) => ({
      key,
      value,
    }));
    const body = entries.map(({ key, value }) => `${key}=${value}`).join('\n');
    await fs.writeFile(this.envFile, `${body}\n`, 'utf8');
  }

  private async getOrLoad(key: string): Promise<string | undefined> {
    await this.ensureLoaded();
    return this.cache.get(key);
  }

  public async getSecret(path: string): Promise<string | undefined> {
    const key = secretPathToKey(path);
    return this.getOrLoad(key);
  }

  public async setSecret(path: string, value: string): Promise<void> {
    const key = secretPathToKey(path);
    await this.ensureLoaded();
    this.cache.set(key, value);
    await this.persist();
  }

  public async ensureSecret(path: string, generator?: () => string): Promise<string> {
    const key = secretPathToKey(path);
    await this.ensureLoaded();
    const existing = this.cache.get(key);
    if (existing) return existing;
    const nextValue = generator ? generator() : FileSecretsProvider.generateDefaultSecret();
    this.cache.set(key, nextValue);
    await this.persist();
    return nextValue;
  }

  private static generateDefaultSecret(): string {
    return crypto.randomBytes(24).toString('base64url');
  }
}

export const createFileSecretsProvider = (options: SecretsProviderFactoryOptions): SecretsProvider => {
  return new FileSecretsProvider(options);
};




