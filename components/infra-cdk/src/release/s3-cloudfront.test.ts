import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASE_META_PREFIX,
  RELEASE_POINTER_KEY,
  generationPrefix,
  listFilesRecursive,
  releaseS3CloudFront,
  resolveStaticSiteSourceDir,
  resolveStaticSiteTargets,
  resolveWebsiteAlias,
  rollbackS3CloudFront,
  type StaticSiteReleasePort,
} from './s3-cloudfront';

function memoryPort(opts?: { lookupId?: string }) {
  const objects = new Map<string, Buffer>();
  const invalidations: string[] = [];
  const lookups: string[] = [];
  const port: StaticSiteReleasePort = {
    async putObject({ key, body }) {
      objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    },
    async invalidate(distributionId) {
      invalidations.push(distributionId);
    },
    async lookupDistributionId(alias) {
      lookups.push(alias);
      return opts?.lookupId;
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
  return { port, objects, invalidations, lookups };
}

describe('s3-cloudfront release paths', () => {
  it('resolves extras.outputPath under the package dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-site-'));
    expect(
      resolveStaticSiteSourceDir({
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        extras: { outputPath: 'dist' },
      }),
    ).toBe(path.join(dir, 'dist'));
  });

  it('lists nested html and css', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-files-'));
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'index.html'), '<html/>');
    fs.writeFileSync(path.join(dir, 'a', 'app.css'), 'body{}');
    expect(listFilesRecursive(dir).sort()).toEqual([
      path.join(dir, 'a', 'app.css'),
      path.join(dir, 'a', 'index.html'),
    ]);
  });

  it('prefers extras.bucket then generated endpoints', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-targets-'));
    fs.mkdirSync(path.join(dir, 'generated'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'generated', 'thonnas-config.generated.json'),
      JSON.stringify({ bucket: 'from-generated', distributionId: 'EFROMGEN' }),
    );
    expect(
      resolveStaticSiteTargets({
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        extras: { bucket: 'from-extras' },
      }),
    ).toEqual({ bucket: 'from-extras', distributionId: 'EFROMGEN' });
  });

  it('publishes a generation then promotes live keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-upload-'));
    fs.mkdirSync(path.join(dir, 'build', 'css'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), '<html/>');
    fs.writeFileSync(path.join(dir, 'build', 'css', 'app.css'), 'body{}');
    const { port, objects, invalidations } = memoryPort();
    const result = await releaseS3CloudFront(
      {
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        imageTag: 'v1',
        extras: { outputPath: 'build', bucket: 'site-bucket', distributionId: 'EDIST' },
      },
      port,
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(objects.has('index.html')).toBe(true);
    expect(objects.has('css/app.css')).toBe(true);
    expect(objects.has(`${generationPrefix('v1')}index.html`)).toBe(true);
    expect(objects.has(RELEASE_POINTER_KEY)).toBe(true);
    expect([...objects.keys()].every((key) => !key.startsWith(`${RELEASE_META_PREFIX}/`) || key.startsWith(RELEASE_META_PREFIX))).toBe(
      true,
    );
    expect(invalidations).toEqual(['EDIST']);
    expect(result.from ?? null).not.toBe('noop');
    expect(result.to).toBe('v1');
  });

  it('keeps the previous generation and rollback restores it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-rb-'));
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), 'one');
    const { port, objects } = memoryPort();
    const ctx = {
      projectRoot: dir,
      env: 'staging',
      packageDir: dir,
      extras: { outputPath: 'build', bucket: 'site-bucket' },
    };
    const first = await releaseS3CloudFront({ ...ctx, imageTag: 'v1' }, port);
    expect(first.to).toBe('v1');
    expect(first.from ?? null).not.toBe('noop');
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), 'two');
    const second = await releaseS3CloudFront({ ...ctx, imageTag: 'v2' }, port);
    expect(second.from).toBe('v1');
    expect(second.to).toBe('v2');
    expect(objects.get('index.html')?.toString()).toBe('two');
    const rolled = await rollbackS3CloudFront(ctx, port);
    expect(rolled.ok).toBe(true);
    expect(objects.get('index.html')?.toString()).toBe('one');
  });

  it('restoreGenerationId promotes that id instead of guessing previous', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-restore-id-'));
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    const { port, objects } = memoryPort();
    const ctx = {
      projectRoot: dir,
      env: 'staging',
      packageDir: dir,
      extras: { outputPath: 'build', bucket: 'site-bucket' },
    };
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), 'one');
    await releaseS3CloudFront({ ...ctx, imageTag: 'v1' }, port);
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), 'two');
    await releaseS3CloudFront({ ...ctx, imageTag: 'v2' }, port);
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), 'three');
    await releaseS3CloudFront({ ...ctx, imageTag: 'v3' }, port);
    expect(objects.get('index.html')?.toString()).toBe('three');
    const rolled = await rollbackS3CloudFront({ ...ctx, restoreGenerationId: 'v1' }, port);
    expect(rolled.ok).toBe(true);
    expect(rolled.to).toBe('v1');
    expect(objects.get('index.html')?.toString()).toBe('one');
  });

  it('fails when the output directory is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-missing-'));
    const { port, objects } = memoryPort();
    const result = await releaseS3CloudFront(
      {
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        extras: { outputPath: 'build', bucket: 'site-bucket' },
      },
      port,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain(path.join(dir, 'build'));
    expect(objects.size).toBe(0);
  });

  it('derives bucket from website_domain when extras omit bucket', () => {
    expect(
      resolveStaticSiteTargets({
        projectRoot: '.',
        env: 'staging',
        component: 'web-angular',
        packageDir: '/tmp',
        extras: {
          website_domain: '{env}.{component}.{rootDomain}',
          hosted_zone_domain: 'example.com',
        },
      }),
    ).toEqual({ bucket: 'staging.web-angular.example.com', distributionId: undefined });
  });

  it('fails when extras.bucket is missing without guessing a name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-nobucket-'));
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), '<html/>');
    const result = await releaseS3CloudFront({
      projectRoot: dir,
      env: 'staging',
      packageDir: dir,
      extras: { outputPath: 'build' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/extras\.bucket/);
    expect(result.message).not.toMatch(/guessed workshop bucket/i);
  });

  it('looks up CloudFront by interpolated alias when extras omit distributionId', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-lookup-'));
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), '<html/>');
    const { port, invalidations, lookups } = memoryPort({ lookupId: 'ELOOKUP' });
    const result = await releaseS3CloudFront(
      {
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        component: 'fixture-web',
        extras: {
          outputPath: 'build',
          bucket: 'site-bucket',
          website_domain: '{env}.{component}.{rootDomain}',
          hosted_zone_domain: 'ts1.parfiamlabs.com',
        },
      },
      port,
    );
    expect(result.ok).toBe(true);
    expect(lookups).toEqual(['staging.fixture-web.ts1.parfiamlabs.com']);
    expect(invalidations).toEqual(['ELOOKUP']);
    expect(result.message).toMatch(/invalidated ELOOKUP/);
  });

  it('resolves a StaticSite distribution id from extras without guessing an Artifact stack', () => {
    expect(
      resolveStaticSiteTargets({
        projectRoot: '.',
        env: 'staging',
        packageDir: '/tmp',
        extras: { bucket: 'fixture-web-origin', distributionId: 'E28JR7QV9UJOCG' },
      }),
    ).toEqual({ bucket: 'fixture-web-origin', distributionId: 'E28JR7QV9UJOCG' });
  });

  it('does not invent a CloudFront id for artifact-only extras', () => {
    expect(
      resolveStaticSiteTargets({
        projectRoot: '.',
        env: 'staging',
        packageDir: '/tmp',
        extras: { bucket: 'sea.thonnas.parfiamlabs.com', prefix: 'staging' },
      }),
    ).toEqual({ bucket: 'sea.thonnas.parfiamlabs.com', distributionId: undefined });
  });

  it('interpolates website_domain with env, component, and hosted zone', () => {
    expect(
      resolveWebsiteAlias({
        projectRoot: '.',
        env: 'staging',
        component: 'fixture-web',
        extras: {
          website_domain: '{env}.{component}.{rootDomain}',
          hosted_zone_domain: 'ts1.parfiamlabs.com',
        },
      }),
    ).toBe('staging.fixture-web.ts1.parfiamlabs.com');
  });

  it('interpolates hosted_zone_domain {rootDomain} from extras or THONNAS_ROOT_DOMAIN', () => {
    expect(
      resolveWebsiteAlias({
        projectRoot: '.',
        env: 'staging',
        component: 'web-angular',
        extras: {
          website_domain: '{env}-{component}.{rootDomain}',
          hosted_zone_domain: '{rootDomain}',
          rootDomain: 'ts1.parfiamlabs.com',
        },
      }),
    ).toBe('staging-web-angular.ts1.parfiamlabs.com');
  });
});



