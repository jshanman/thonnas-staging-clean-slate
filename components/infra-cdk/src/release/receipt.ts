import { randomUUID } from 'node:crypto';

// @intent Define the persisted release run receipt (UUID, not generation id)

export type ReleaseReceiptPackageKind = 'released' | 'noop' | 'not-implemented';

export type ReleaseReceiptPackage = {
  key: string;
  binding: string;
  from: string | null;
  to: string;
  kind: ReleaseReceiptPackageKind;
};

export type ReleaseReceiptStatus = 'deployed' | 'superseded' | 'failed' | 'compensated';

export type ReleaseReceipt = {
  schemaVersion: 1;
  releaseId: string;
  env: string;
  createdAt: string;
  status: ReleaseReceiptStatus;
  undoes?: string;
  cause?: string;
  packages: ReleaseReceiptPackage[];
};

export function mintReleaseId(): string {
  return randomUUID();
}

export function isClosedReceiptStatus(status: ReleaseReceiptStatus): boolean {
  return status === 'superseded' || status === 'compensated';
}



