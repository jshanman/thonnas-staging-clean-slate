import { describe, expect, it } from '@jest/globals';
import { executeRollback } from './bindings';
import { MemoryReceiptStore } from './receipt-store.memory';
import { ReceiptAlreadyExistsError, receiptParameterPath } from './receipt-store';
import { mintReleaseId, type ReleaseReceipt } from './receipt';
import {
  formatHistoryTable,
  persistSuccessfulRelease,
  putReceiptMinting,
  rollbackByReleaseId,
} from './receipt-run';

function receipt(overrides: Partial<ReleaseReceipt> = {}): ReleaseReceipt {
  return {
    schemaVersion: 1,
    releaseId: mintReleaseId(),
    env: 'staging',
    createdAt: '2026-08-31T00:00:00.000Z',
    status: 'deployed',
    packages: [{ key: 'fixture-db', binding: 'rds-postgres', from: null, to: 'noop', kind: 'noop' }],
    ...overrides,
  };
}

describe('memory receipt store', () => {
  it('puts and lists in createdAt order', async () => {
    const store = new MemoryReceiptStore();
    await store.put(receipt({ releaseId: 'a', createdAt: '2026-08-31T02:00:00.000Z' }));
    await store.put(receipt({ releaseId: 'b', createdAt: '2026-08-31T01:00:00.000Z' }));
    expect((await store.list()).map((item) => item.releaseId)).toEqual(['b', 'a']);
  });

  it('rejects overwrite=false collisions', async () => {
    const store = new MemoryReceiptStore();
    const first = receipt({ releaseId: 'same' });
    await store.put(first);
    await expect(store.put(receipt({ releaseId: 'same' }), false)).rejects.toBeInstanceOf(ReceiptAlreadyExistsError);
  });

  it('builds the SSM path from project and env, never cwd', () => {
    expect(receiptParameterPath('live-feat001', 'staging', 'abc')).toBe(
      '/thonnas/live-feat001/staging/releases/abc',
    );
  });
});

describe('persistSuccessfulRelease', () => {
  it('includes no-op rows and skips not-implemented', async () => {
    const store = new MemoryReceiptStore();
    const stored = await persistSuccessfulRelease({
      store,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [
        { projectRoot: '/tmp', env: 'staging', component: 'fixture-db' },
        { projectRoot: '/tmp', env: 'staging', component: 'api-nest' },
      ],
      results: [
        { ok: true, kind: 'noop', binding: 'rds-postgres', message: 'noop', from: null, to: 'noop' },
        { ok: false, kind: 'not-implemented', binding: 'ecs-fargate', message: 'later' },
      ],
    });
    expect(stored.packages).toEqual([
      { key: 'fixture-db', binding: 'rds-postgres', from: null, to: 'noop', kind: 'noop' },
    ]);
    expect(stored.releaseId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('fails the release path when persist throws a non-collision error', async () => {
    const store = {
      async put() {
        throw new Error('ssm down');
      },
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
      async supersede() {},
    };
    await expect(
      persistSuccessfulRelease({
        store,
        env: 'staging',
        projectRoot: '/tmp',
        writeCache: false,
        contexts: [{ projectRoot: '/tmp', env: 'staging', component: 'fixture-db' }],
        results: [{ ok: true, kind: 'noop', binding: 'rds-postgres', message: 'noop', from: null, to: 'noop' }],
      }),
    ).rejects.toThrow(/ssm down/);
  });

  it('mints a new id when overwrite=false collides', async () => {
    const store = new MemoryReceiptStore();
    await store.put(receipt({ releaseId: 'taken' }));
    const minted = await putReceiptMinting(store, receipt({ releaseId: 'taken' }));
    expect(minted.releaseId).not.toBe('taken');
    expect(await store.get(minted.releaseId)).toBeDefined();
  });
});

describe('rollbackByReleaseId', () => {
  it('writes Y, supersedes X, and fails a second rollback of X', async () => {
    const store = new MemoryReceiptStore();
    const original = await persistSuccessfulRelease({
      store,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [{ projectRoot: '/tmp', env: 'staging', component: 'fixture-db' }],
      results: [{ ok: true, kind: 'noop', binding: 'rds-postgres', message: 'noop', from: null, to: 'noop' }],
    });
    const rolled: string[] = [];
    const next = await rollbackByReleaseId({
      store,
      releaseId: original.releaseId,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [{ projectRoot: '/tmp', env: 'staging', component: 'fixture-db' }],
      rollback: async (ctx) => {
        rolled.push(ctx.component ?? '');
        return { ok: true, kind: 'noop', binding: 'rds-postgres', message: 'noop', from: null, to: 'noop' };
      },
    });
    expect(next.undoes).toBe(original.releaseId);
    expect(next.releaseId).not.toBe(original.releaseId);
    expect((await store.get(original.releaseId))?.status).toBe('superseded');
    expect(rolled).toEqual(['fixture-db']);
    await expect(
      rollbackByReleaseId({
        store,
        releaseId: original.releaseId,
        env: 'staging',
        projectRoot: '/tmp',
        writeCache: false,
        contexts: [{ projectRoot: '/tmp', env: 'staging', component: 'fixture-db' }],
        rollback: async () => ({ ok: true, kind: 'noop', binding: 'rds-postgres', message: 'noop' }),
      }),
    ).rejects.toThrow(/superseded/);
  });

  it('rolls back a persisted relational no-op via executeRollback without an RDS client', async () => {
    const store = new MemoryReceiptStore();
    const original = await persistSuccessfulRelease({
      store,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [
        { projectRoot: '/tmp', env: 'staging', component: 'fixture-db', strategyKey: 'infra.db.relational' },
      ],
      results: [{ ok: true, kind: 'noop', binding: 'rds-postgres', message: 'noop', from: null, to: 'noop' }],
    });
    const next = await rollbackByReleaseId({
      store,
      releaseId: original.releaseId,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [
        { projectRoot: '/tmp', env: 'staging', component: 'fixture-db', strategyKey: 'infra.db.relational' },
      ],
      rollback: executeRollback,
    });
    expect(next.undoes).toBe(original.releaseId);
    expect(next.packages).toEqual([
      { key: 'fixture-db', binding: 'rds-postgres', from: 'noop', to: 'noop', kind: 'noop' },
    ]);
    expect((await store.get(original.releaseId))?.status).toBe('superseded');
  });

  it('rolls back a persisted document no-op via executeRollback without a DocDB client', async () => {
    const store = new MemoryReceiptStore();
    const original = await persistSuccessfulRelease({
      store,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [
        { projectRoot: '/tmp', env: 'staging', component: 'fixture-doc', strategyKey: 'infra.db.document' },
      ],
      results: [{ ok: true, kind: 'noop', binding: 'docdb', message: 'noop', from: null, to: 'noop' }],
    });
    const next = await rollbackByReleaseId({
      store,
      releaseId: original.releaseId,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [
        { projectRoot: '/tmp', env: 'staging', component: 'fixture-doc', strategyKey: 'infra.db.document' },
      ],
      rollback: executeRollback,
    });
    expect(next.undoes).toBe(original.releaseId);
    expect(next.packages).toEqual([
      { key: 'fixture-doc', binding: 'docdb', from: 'noop', to: 'noop', kind: 'noop' },
    ]);
    expect((await store.get(original.releaseId))?.status).toBe('superseded');
  });

  it('rolls back a persisted cache no-op via executeRollback without an ElastiCache client', async () => {
    const store = new MemoryReceiptStore();
    const original = await persistSuccessfulRelease({
      store,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [
        { projectRoot: '/tmp', env: 'staging', component: 'fixture-cache', strategyKey: 'infra.cache.keyvalue' },
      ],
      results: [{ ok: true, kind: 'noop', binding: 'elasticache-redis', message: 'noop', from: null, to: 'noop' }],
    });
    const next = await rollbackByReleaseId({
      store,
      releaseId: original.releaseId,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [
        { projectRoot: '/tmp', env: 'staging', component: 'fixture-cache', strategyKey: 'infra.cache.keyvalue' },
      ],
      rollback: executeRollback,
    });
    expect(next.undoes).toBe(original.releaseId);
    expect(next.packages).toEqual([
      { key: 'fixture-cache', binding: 'elasticache-redis', from: 'noop', to: 'noop', kind: 'noop' },
    ]);
    expect((await store.get(original.releaseId))?.status).toBe('superseded');
  });

  it('rolls back a persisted ecs-fargate released row with a new id and undoes', async () => {
    const store = new MemoryReceiptStore();
    const original = await persistSuccessfulRelease({
      store,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [
        { projectRoot: '/tmp', env: 'staging', component: 'fixture-api', strategyKey: 'infra.container.managed-host' },
      ],
      results: [
        {
          ok: true,
          kind: 'released',
          binding: 'ecs-fargate',
          message: 'ok',
          from: 'arn:td:1',
          to: 'arn:td:2',
        },
      ],
    });
    const next = await rollbackByReleaseId({
      store,
      releaseId: original.releaseId,
      env: 'staging',
      projectRoot: '/tmp',
      writeCache: false,
      contexts: [
        { projectRoot: '/tmp', env: 'staging', component: 'fixture-api', strategyKey: 'infra.container.managed-host' },
      ],
      rollback: async (ctx) => {
        expect(ctx.restoreGenerationId).toBe('arn:td:1');
        return {
          ok: true,
          kind: 'released',
          binding: 'ecs-fargate',
          message: 'undone',
          from: 'arn:td:2',
          to: 'arn:td:1',
        };
      },
    });
    expect(next.undoes).toBe(original.releaseId);
    expect(next.packages).toEqual([
      { key: 'fixture-api', binding: 'ecs-fargate', from: 'arn:td:2', to: 'arn:td:1', kind: 'released' },
    ]);
    expect((await store.get(original.releaseId))?.status).toBe('superseded');
  });

  it('fails closed on an unknown id', async () => {
    const store = new MemoryReceiptStore();
    await expect(
      rollbackByReleaseId({
        store,
        releaseId: '00000000-0000-0000-0000-000000000000',
        env: 'staging',
        projectRoot: '/tmp',
        writeCache: false,
        contexts: [],
        rollback: async () => ({ ok: true, kind: 'noop', binding: 'rds-postgres', message: 'noop' }),
      }),
    ).rejects.toThrow(/Unknown --release-id/);
  });

  it('prints history with UNDOES', async () => {
    const table = formatHistoryTable([
      {
        schemaVersion: 1,
        releaseId: '11111111-1111-4111-8111-111111111111',
        env: 'staging',
        createdAt: '2026-08-31T00:00:00.000Z',
        status: 'superseded',
        packages: [{ key: 'fixture-db', binding: 'rds-postgres', from: null, to: 'noop', kind: 'noop' }],
      },
      {
        schemaVersion: 1,
        releaseId: '22222222-2222-4222-8222-222222222222',
        env: 'staging',
        createdAt: '2026-08-31T00:01:00.000Z',
        status: 'deployed',
        undoes: '11111111-1111-4111-8111-111111111111',
        packages: [{ key: 'fixture-db', binding: 'rds-postgres', from: 'noop', to: 'noop', kind: 'noop' }],
      },
    ]);
    expect(table).toMatch(/RELEASE ID/);
    expect(table).toMatch(/11111111-1111-4111-8111-111111111111/);
    expect(table).toMatch(/22222222-2222-4222-8222-222222222222/);
    expect(table).toMatch(/superseded/);
  });
});



