import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindingForStrategy,
  executeRelease,
  executeRollback,
  runReleaseBinding,
  runReleaseForStrategy,
  runRollbackableBatch,
} from './bindings';
import { assertEnvNotNamedRelease, RELEASE_ENV_FORBIDDEN_MESSAGE } from './forbidden-env';
import type { StaticSiteReleasePort } from './s3-cloudfront';

jest.mock('./ecs-fargate', () => ({
  releaseEcsFargate: jest.fn(async () => ({
    ok: true,
    kind: 'released',
    binding: 'ecs-fargate',
    from: 'arn:td:1',
    to: 'arn:td:2',
    message: 'mocked release',
  })),
  rollbackEcsFargate: jest.fn(async (ctx: { restoreGenerationId?: string }) => {
    if (!ctx.restoreGenerationId?.trim()) {
      return {
        ok: false,
        kind: 'unknown',
        binding: 'ecs-fargate',
        message: 'ecs-fargate rollback requires restoreGenerationId (receipt from task definition ARN).',
      };
    }
    return {
      ok: true,
      kind: 'released',
      binding: 'ecs-fargate',
      from: 'arn:td:2',
      to: ctx.restoreGenerationId,
      message: 'mocked rollback',
    };
  }),
}));

describe('release bindings', () => {
  it('maps website.static to s3-cloudfront', () => {
    expect(bindingForStrategy('infra.website.static')).toBe('s3-cloudfront');
  });

  it('does not invent a CDN binding for artifact.deploy', () => {
    expect(bindingForStrategy('infra.artifact.deploy')).toBe('s3-artifact');
    expect(bindingForStrategy('infra.artifact.deploy')).not.toBe('s3-cloudfront');
    expect(bindingForStrategy('infra.website.static')).toBe('s3-cloudfront');
    const artifact = runReleaseForStrategy('infra.artifact.deploy');
    expect(artifact.kind).toBe('not-implemented');
    expect(artifact.message).toMatch(/executeRelease/);
  });

  it('maps storage-temp-url to lambda-alias', () => {
    expect(bindingForStrategy('infra.api.storage-temp-url')).toBe('lambda-alias');
    expect(bindingForStrategy('infra.api.storage-temp-url')).not.toBe('s3-cloudfront');
    const result = runReleaseForStrategy('infra.api.storage-temp-url');
    expect(result.kind).toBe('not-implemented');
    expect(result.message).toMatch(/executeRelease/);
  });

  it('keeps the sync table as metadata for s3-cloudfront', () => {
    const result = runReleaseForStrategy('infra.website.static');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('not-implemented');
    expect(result.message).toMatch(/executeRelease/);
  });

  it('executeRelease uploads when context has packageDir and extras', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-release-'));
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'index.html'), '<html/>');
    const objects = new Map<string, Buffer>();
    const port: StaticSiteReleasePort = {
      async putObject({ key, body }) {
        objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from('x'));
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
    const result = await executeRelease(
      {
        projectRoot: dir,
        env: 'staging',
        packageDir: dir,
        strategyKey: 'infra.website.static',
        extras: { outputPath: 'build', bucket: 'site-bucket' },
      },
      port,
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(objects.has('index.html')).toBe(true);
  });

  it('executeRelease fails when the output folder is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-missing-'));
    const result = await executeRelease({
      projectRoot: dir,
      env: 'staging',
      packageDir: dir,
      strategyKey: 'infra.website.static',
      extras: { outputPath: 'build', bucket: 'site-bucket' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(path.join(dir, 'build'));
  });

  it('maps observe keys to ecs-fargate and fails closed on removed observe-signoz name', async () => {
    expect(bindingForStrategy('infra.observe.metrics')).toBe('ecs-fargate');
    expect(bindingForStrategy('infra.observe.dashboard')).toBe('ecs-fargate');
    const removed = runReleaseBinding('observe-signoz');
    expect(removed.ok).toBe(false);
    expect(removed.kind).toBe('unknown');
    expect(removed.binding).toBe('observe-signoz');
    const released = await executeRelease({
      projectRoot: '/tmp',
      env: 'staging',
      strategyKey: 'infra.observe.metrics',
      component: 'fixture-observe',
    });
    expect(released.ok).toBe(true);
    expect(released.kind).toBe('released');
    expect(released.binding).toBe('ecs-fargate');
    const rolled = await executeRollback({
      projectRoot: '/tmp',
      env: 'staging',
      strategyKey: 'infra.observe.dashboard',
      component: 'fixture-observe',
      restoreGenerationId: 'arn:td:1',
    });
    expect(rolled.ok).toBe(true);
    expect(rolled.kind).toBe('released');
    expect(rolled.binding).toBe('ecs-fargate');
  });

  it('keeps nlb-tcp unimplemented so managed-host stays ecs-fargate', () => {
    expect(bindingForStrategy('infra.container.managed-host')).toBe('ecs-fargate');
    const result = runReleaseBinding('nlb-tcp');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('not-implemented');
    expect(result.binding).toBe('nlb-tcp');
  });

  it('maps infra.worker.temporal to the apply-only temporal no-op (worker-manager-temporal has no Dockerfile/release artifact)', () => {
    expect(bindingForStrategy('infra.worker.temporal')).toBe('temporal');
    const result = runReleaseBinding('temporal');
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.binding).toBe('temporal');
  });

  it('release for worker temporal is a no-op, not a dispatch to the ecs-fargate helper', async () => {
    const result = await executeRelease({
      projectRoot: '/tmp',
      env: 'staging',
      strategyKey: 'infra.worker.temporal',
      component: 'fixture-temporal',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.binding).toBe('temporal');
  });

  it('rollback for worker temporal is a no-op, not a dispatch to the ecs-fargate helper', async () => {
    const result = await executeRollback({
      projectRoot: '/tmp',
      env: 'staging',
      strategyKey: 'infra.worker.temporal',
      component: 'fixture-temporal',
      restoreGenerationId: 'arn:td:1',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.binding).toBe('temporal');
  });

  it('dispatches temporal-ui managed-host release to the ecs-fargate helper', async () => {
    const result = await executeRelease({
      projectRoot: '/tmp',
      env: 'staging',
      strategyKey: 'infra.container.managed-host',
      component: 'fixture-temporal-ui',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(result.binding).toBe('ecs-fargate');
    expect(result.from).toBe('arn:td:1');
    expect(result.to).toBe('arn:td:2');
  });

  it('fails closed when temporal-ui rollback omits restoreGenerationId', async () => {
    const result = await executeRollback({
      projectRoot: '/tmp',
      env: 'staging',
      strategyKey: 'infra.container.managed-host',
      component: 'fixture-temporal-ui',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/restoreGenerationId/);
  });

  it('dispatches managed-host to the ecs-fargate helper', async () => {
    const result = await executeRelease({
      projectRoot: '/tmp',
      env: 'staging',
      strategyKey: 'infra.container.managed-host',
      component: 'fixture-api',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(result.binding).toBe('ecs-fargate');
    expect(result.from).toBe('arn:td:1');
    expect(result.to).toBe('arn:td:2');
  });

  it('dispatches managed-host rollback to the ecs-fargate helper', async () => {
    const result = await executeRollback({
      projectRoot: '/tmp',
      env: 'staging',
      strategyKey: 'infra.container.managed-host',
      component: 'fixture-api',
      restoreGenerationId: 'arn:td:1',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(result.binding).toBe('ecs-fargate');
    expect(result.to).toBe('arn:td:1');
  });

  it('treats relational/document/cache as no-op', () => {
    expect(runReleaseBinding('rds-postgres').ok).toBe(true);
    expect(runReleaseBinding('rds-postgres').kind).toBe('noop');
    expect(runReleaseBinding('rds-postgres').from).toBeNull();
    expect(runReleaseBinding('rds-postgres').to).toBe('noop');
    expect(runReleaseBinding('rds-postgres').message).toMatch(/apply-only/);
    expect(runReleaseBinding('docdb').kind).toBe('noop');
    expect(runReleaseBinding('elasticache-redis').kind).toBe('noop');
    expect(runReleaseBinding('clickhouse').kind).toBe('unknown');
    expect(runReleaseBinding('columnar-store').kind).toBe('unknown');
  });

  it('maps both infra.compute.fleet.* strategies to the real fleet binding, implemented by executeRelease/executeRollback (not a no-op)', () => {
    expect(bindingForStrategy('infra.compute.fleet.dba')).toBe('fleet');
    expect(bindingForStrategy('infra.compute.fleet.mqtt')).toBe('fleet');
    const result = runReleaseBinding('fleet');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('not-implemented');
    expect(result.message).toMatch(/executeRelease\/executeRollback/);
  });

  it('treats compose-host as a no-op handled by release.compose-host, not this mechanism', () => {
    expect(bindingForStrategy('infra.container.compose-host')).toBe('compose-host');
    const result = runReleaseBinding('compose-host');
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.from).toBeNull();
    expect(result.to).toBe('noop');
    expect(result.message).toMatch(/release\.compose-host/);
  });

  it('runReleaseForStrategy resolves infra.container.compose-host to a no-op, not "unknown"', () => {
    const result = runReleaseForStrategy('infra.container.compose-host');
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
  });

  it('a project of only compose-host components completes the batch instead of aborting on the first one', async () => {
    const jobs = [
      { projectRoot: '/tmp', env: 'beta', packageDir: '/tmp/a', component: 'a', strategyKey: 'infra.container.compose-host' },
      { projectRoot: '/tmp', env: 'beta', packageDir: '/tmp/b', component: 'b', strategyKey: 'infra.container.compose-host' },
    ];
    const results = await runRollbackableBatch(jobs, executeRelease, executeRollback);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok && r.kind === 'noop')).toBe(true);
  });

  it('executeRelease for infra.db.document is a no-op without S3', async () => {
    const result = await executeRelease({
      projectRoot: '/tmp',
      env: 'staging',
      packageDir: '/tmp',
      strategyKey: 'infra.db.document',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.binding).toBe('docdb');
  });

  it('executeRelease for infra.db.relational is a no-op without S3', async () => {
    const result = await executeRelease({
      projectRoot: '/tmp',
      env: 'staging',
      packageDir: '/tmp',
      strategyKey: 'infra.db.relational',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.binding).toBe('rds-postgres');
  });

  it('rejects unknown bindings', () => {
    const result = runReleaseBinding('not-a-binding');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('unknown');
  });

  it('treats a missing strategy key as a no-op, not a fatal error', () => {
    const result = runReleaseForStrategy(undefined);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.from).toBeNull();
    expect(result.to).toBe('noop');
    expect(result.message).toMatch(/no strategy declared/i);
  });

  it('rolls back a succeeded release when a later job fails', async () => {
    const rolled: string[] = [];
    await expect(
      runRollbackableBatch(
        [
          { projectRoot: '/tmp', env: 'staging', component: 'a', strategyKey: 'infra.website.static' },
          { projectRoot: '/tmp', env: 'staging', component: 'b', strategyKey: 'infra.website.static' },
        ],
        async (ctx) =>
          ctx.component === 'a'
            ? { ok: true, kind: 'released', binding: 's3-cloudfront', message: 'ok' }
            : { ok: false, kind: 'unknown', binding: 's3-cloudfront', message: 'boom' },
        async (ctx) => {
          rolled.push(ctx.component ?? '');
          return { ok: true, kind: 'released', binding: 's3-cloudfront', message: 'undone' };
        },
      ),
    ).rejects.toThrow(/boom/);
    expect(rolled).toEqual(['a']);
  });

  it('rolls succeeded jobs back in reverse order when a later job fails', async () => {
    const rolled: string[] = [];
    await expect(
      runRollbackableBatch(
        [
          { projectRoot: '/tmp', env: 'staging', component: 'a', strategyKey: 'infra.website.static' },
          { projectRoot: '/tmp', env: 'staging', component: 'b', strategyKey: 'infra.website.static' },
          { projectRoot: '/tmp', env: 'staging', component: 'c', strategyKey: 'infra.website.static' },
        ],
        async (ctx) =>
          ctx.component === 'c'
            ? { ok: false, kind: 'unknown', binding: 's3-cloudfront', message: 'boom' }
            : { ok: true, kind: 'released', binding: 's3-cloudfront', message: 'ok' },
        async (ctx) => {
          rolled.push(ctx.component ?? '');
          return { ok: true, kind: 'released', binding: 's3-cloudfront', message: 'undone' };
        },
      ),
    ).rejects.toThrow(/boom/);
    expect(rolled).toEqual(['b', 'a']);
  });

  it('executeRollback is a no-op for relational', async () => {
    const result = await executeRollback({
      projectRoot: '/tmp',
      env: 'staging',
      component: 'fixture-db',
      strategyKey: 'infra.db.relational',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.binding).toBe('rds-postgres');
    expect(result.from).toBeNull();
    expect(result.to).toBe('noop');
    expect(result.message).toMatch(/apply-only/);
  });

  it('executeRollback is a no-op for document', async () => {
    const result = await executeRollback({
      projectRoot: '/tmp',
      env: 'staging',
      component: 'fixture-doc',
      strategyKey: 'infra.db.document',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.binding).toBe('docdb');
    expect(result.from).toBeNull();
    expect(result.to).toBe('noop');
    expect(result.message).toMatch(/apply-only/);
  });

  it('executeRollback is a no-op for cache', async () => {
    const result = await executeRollback({
      projectRoot: '/tmp',
      env: 'staging',
      component: 'fixture-cache',
      strategyKey: 'infra.cache.keyvalue',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
    expect(result.binding).toBe('elasticache-redis');
    expect(result.from).toBeNull();
    expect(result.to).toBe('noop');
    expect(result.message).toMatch(/apply-only/);
  });


  it('rejects env named release', () => {
    expect(() => assertEnvNotNamedRelease('release')).toThrow(RELEASE_ENV_FORBIDDEN_MESSAGE);
    expect(() => assertEnvNotNamedRelease('staging')).not.toThrow();
  });
});



