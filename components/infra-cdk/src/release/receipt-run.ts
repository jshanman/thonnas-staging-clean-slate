import fs from 'node:fs/promises';
import path from 'node:path';
import type { BindingResult } from './bindings';
import type { ReleaseContext } from './context';
import {
  isClosedReceiptStatus,
  mintReleaseId,
  type ReleaseReceipt,
  type ReleaseReceiptPackage,
} from './receipt';
import { ReceiptAlreadyExistsError, type ReceiptStore } from './receipt-store';
import { buildReleaseContext } from './load-target';

const PUT_RETRIES = 8;

// @intent Mint a unique id when Overwrite=false hits an existing parameter
export async function putReceiptMinting(
  store: ReceiptStore,
  receipt: ReleaseReceipt,
): Promise<ReleaseReceipt> {
  let current = receipt;
  for (let attempt = 0; attempt < PUT_RETRIES; attempt += 1) {
    try {
      return await store.put(current, false);
    } catch (error) {
      if (!(error instanceof ReceiptAlreadyExistsError) && (error as { name?: string }).name !== 'ParameterAlreadyExists') {
        throw error;
      }
      current = { ...current, releaseId: mintReleaseId() };
    }
  }
  throw new Error('Could not allocate a unique release id');
}

// @intent Name a receipt row from the package flags, never cwd
export function packageKey(ctx: ReleaseContext): string {
  return ctx.component ?? ctx.lib ?? ctx.module ?? path.basename(ctx.packageDir ?? 'package');
}

// @intent Load extras/strategy for a receipt package when the current filter omits it
function contextForReceiptPackage(
  pkg: ReleaseReceiptPackage,
  contexts: ReleaseContext[],
  projectRoot: string,
  env: string,
): ReleaseContext {
  const found = contexts.find((item) => packageKey(item) === pkg.key);
  if (found) return found;
  return buildReleaseContext(projectRoot, env, { targetComponent: pkg.key });
}

// @intent Keep not-implemented rows off the receipt; keep no-op and released
export function packagesFromResults(
  results: BindingResult[],
  contexts: ReleaseContext[],
): ReleaseReceiptPackage[] {
  const packages: ReleaseReceiptPackage[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.kind === 'not-implemented' || result.kind === 'unknown') continue;
    const ctx = contexts[i];
    packages.push({
      key: ctx ? packageKey(ctx) : result.binding,
      binding: result.binding,
      from: result.from ?? null,
      to: result.to ?? (result.kind === 'noop' ? 'noop' : ''),
      kind: result.kind === 'released' ? 'released' : 'noop',
    });
  }
  return packages;
}

export async function writeReceiptCache(
  projectRoot: string,
  env: string,
  receipt: ReleaseReceipt,
): Promise<void> {
  const dir = path.join(projectRoot, 'generated', env, 'release-receipts');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${receipt.releaseId}.json`), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

// @intent Persist after a successful batch; fail the CLI if the store write fails
export async function persistSuccessfulRelease(options: {
  store: ReceiptStore;
  env: string;
  projectRoot: string;
  results: BindingResult[];
  contexts: ReleaseContext[];
  undoes?: string;
  cause?: string;
  writeCache?: boolean;
}): Promise<ReleaseReceipt> {
  const packages = packagesFromResults(options.results, options.contexts);
  const receipt: ReleaseReceipt = {
    schemaVersion: 1,
    releaseId: mintReleaseId(),
    env: options.env,
    createdAt: new Date().toISOString(),
    status: 'deployed',
    ...(options.undoes ? { undoes: options.undoes } : {}),
    ...(options.cause ? { cause: options.cause } : {}),
    packages,
  };
  const stored = await putReceiptMinting(options.store, receipt);
  if (options.writeCache !== false) {
    try {
      await writeReceiptCache(options.projectRoot, options.env, stored);
    } catch {
      // generated/ is cache only
    }
  }
  return stored;
}

export async function rollbackByReleaseId(options: {
  store: ReceiptStore;
  releaseId: string;
  env: string;
  projectRoot: string;
  contexts: ReleaseContext[];
  rollback: (ctx: ReleaseContext) => Promise<BindingResult>;
  writeCache?: boolean;
}): Promise<ReleaseReceipt> {
  const original = await options.store.get(options.releaseId);
  if (!original) {
    throw new Error(`Unknown --release-id ${options.releaseId}. List ids with thonnas release history --env.`);
  }
  if (isClosedReceiptStatus(original.status)) {
    throw new Error(`Release ${options.releaseId} is ${original.status} and cannot be rolled back again.`);
  }

  const results: BindingResult[] = [];
  const rollbackContexts: ReleaseContext[] = [];
  for (const pkg of [...original.packages].reverse()) {
    const ctx = contextForReceiptPackage(pkg, options.contexts, options.projectRoot, options.env);
    const next: ReleaseContext = {
      ...ctx,
      restoreGenerationId: pkg.from ?? undefined,
    };
    const result = await options.rollback(next);
    if (!result.ok && result.kind !== 'not-implemented') {
      throw new Error(result.message);
    }
    results.push({
      ...result,
      from: pkg.to,
      to: pkg.from ?? 'noop',
    });
    rollbackContexts.push(next);
  }

  const nextReceipt = await persistSuccessfulRelease({
    store: options.store,
    env: options.env,
    projectRoot: options.projectRoot,
    results,
    contexts: rollbackContexts,
    undoes: original.releaseId,
    writeCache: options.writeCache,
  });
  await options.store.supersede(original.releaseId);
  return nextReceipt;
}

// @intent Print operator-facing history; sort is done by the store
export function formatHistoryTable(receipts: ReleaseReceipt[]): string {
  const header = 'RELEASE ID                             STATUS       UNDOES                                   PACKAGES';
  const rows = receipts.map((receipt) => {
    const packages = receipt.packages
      .map((pkg) => `${pkg.key}:${pkg.from ?? '∅'}→${pkg.to}`)
      .join(', ');
    return [
      receipt.releaseId.padEnd(37),
      receipt.status.padEnd(12),
      (receipt.undoes ?? '-').padEnd(38),
      packages || '-',
    ].join(' ');
  });
  return [header, ...rows].join('\n');
}



