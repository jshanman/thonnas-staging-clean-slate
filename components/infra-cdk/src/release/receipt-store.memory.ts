import { ReceiptAlreadyExistsError, type ReceiptStore } from './receipt-store';
import type { ReleaseReceipt } from './receipt';

// @intent In-memory receipt store for unit tests (no AWS)

export class MemoryReceiptStore implements ReceiptStore {
  private readonly receipts = new Map<string, ReleaseReceipt>();

  async put(receipt: ReleaseReceipt, overwrite = false): Promise<ReleaseReceipt> {
    if (!overwrite && this.receipts.has(receipt.releaseId)) {
      throw new ReceiptAlreadyExistsError(receipt.releaseId);
    }
    const copy: ReleaseReceipt = { ...receipt, packages: receipt.packages.map((pkg) => ({ ...pkg })) };
    this.receipts.set(receipt.releaseId, copy);
    return copy;
  }

  async get(releaseId: string): Promise<ReleaseReceipt | undefined> {
    const found = this.receipts.get(releaseId);
    return found ? { ...found, packages: found.packages.map((pkg) => ({ ...pkg })) } : undefined;
  }

  async list(): Promise<ReleaseReceipt[]> {
    return [...this.receipts.values()]
      .map((receipt) => ({ ...receipt, packages: receipt.packages.map((pkg) => ({ ...pkg })) }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async supersede(releaseId: string): Promise<void> {
    const current = this.receipts.get(releaseId);
    if (!current) {
      throw new Error(`Unknown release id ${releaseId}`);
    }
    this.receipts.set(releaseId, { ...current, status: 'superseded' });
  }
}



