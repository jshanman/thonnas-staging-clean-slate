import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_POINTER_KEY, generationPrefix } from './s3-cloudfront';
import {
  collectArtifactSourceFiles,
  releaseS3Artifact,
  resolveArtifactLivePrefix,
  rollbackS3Artifact,
  type ArtifactReleasePort,
} from './s3-artifact';

function memoryPort() {
  const objects = new Map<string, Buffer>();
  const port: ArtifactReleasePort = {
    async putObject({ key, body }) {
      objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    },
    async listKeys(_bucket, prefix) {
      const keys = [...objects.keys()];
      return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
    },
    async copyObject(_bucket, fromKey, toKey) {
      const value = objects.get(fromKey);
      if (value) objects.set(toKey, Buffer.from(value));
    },
    async deleteObject(_bucket, key) {
      objects.delete(key);
    },
    async getObject(_bucket, key) {
      const value = objects.get(key);
      return value ? Buffer.from(value) : undefined;
    },
  };
  return { port, objects };
}

describe('s3-artifact release', () => {
  it('resolves live prefix from extras.prefix then env', () => {
    expect(resolveArtifactLivePrefix({ projectRoot: '/tmp', env: 'staging', extras: { prefix: 'cli' } })).toBe(
      'cli',
    );
    expect(resolveArtifactLivePrefix({ projectRoot: '/tmp', env: 'staging' })).toBe('staging');
  });

  it('collects artifactPath under the package dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-src-'));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'app.bin'), 'A');
    expect(
      collectArtifactSourceFiles({
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        extras: { artifactPath: 'dist/app.bin' },
      }),
    ).toEqual([path.join(dir, 'dist', 'app.bin')]);
  });

  it('uploads then promotes onto extras.prefix without CloudFront', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-up-'));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'app.bin'), 'A');
    const { port, objects } = memoryPort();
    const result = await releaseS3Artifact(
      {
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        imageTag: 'v1',
        extras: { bucket: 'cli-binaries', prefix: 'staging', artifactPath: 'dist/app.bin' },
      },
      port,
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(result.binding).toBe('s3-artifact');
    expect(result.from).toBeNull();
    expect(result.to).toBe('v1');
    expect(objects.get('staging/app.bin')?.toString()).toBe('A');
    expect(objects.has(`${generationPrefix('v1')}app.bin`)).toBe(true);
    expect(objects.has(RELEASE_POINTER_KEY)).toBe(true);
    expect(objects.has('app.bin')).toBe(false);
  });

  it('keeps the previous generation and rollback restores it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-rb-'));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'app.bin'), 'one');
    const { port, objects } = memoryPort();
    const ctx = {
      projectRoot: dir,
      env: 'staging',
      packageDir: dir,
      extras: { bucket: 'cli-binaries', prefix: 'staging', outputPath: 'dist' },
    };
    await releaseS3Artifact({ ...ctx, imageTag: 'v1' }, port);
    fs.writeFileSync(path.join(dir, 'dist', 'app.bin'), 'two');
    const second = await releaseS3Artifact({ ...ctx, imageTag: 'v2' }, port);
    expect(second.from).toBe('v1');
    expect(objects.get('staging/app.bin')?.toString()).toBe('two');
    expect(objects.get(`${generationPrefix('v1')}app.bin`)?.toString()).toBe('one');
    const rolled = await rollbackS3Artifact({ ...ctx, restoreGenerationId: 'v1' }, port);
    expect(rolled.ok).toBe(true);
    expect(rolled.to).toBe('v1');
    expect(objects.get('staging/app.bin')?.toString()).toBe('one');
    expect(objects.has(`${generationPrefix('v2')}app.bin`)).toBe(true);
  });

  it('fail-closes when there is no previous generation and leaves live', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-first-'));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'app.bin'), 'one');
    const { port, objects } = memoryPort();
    const ctx = {
      projectRoot: dir,
      env: 'staging',
      packageDir: dir,
      extras: { bucket: 'cli-binaries', prefix: 'staging', outputPath: 'dist' },
    };
    await releaseS3Artifact({ ...ctx, imageTag: 'v1' }, port);
    const rolled = await rollbackS3Artifact(ctx, port);
    expect(rolled.ok).toBe(false);
    expect(rolled.message).toMatch(/no previous generation/);
    expect(objects.get('staging/app.bin')?.toString()).toBe('one');
  });

  it('fail-closes when the source is empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-empty-'));
    const { port } = memoryPort();
    const result = await releaseS3Artifact(
      {
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        extras: { bucket: 'cli-binaries', prefix: 'staging', outputPath: 'dist' },
      },
      port,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no payload/);
  });
});



