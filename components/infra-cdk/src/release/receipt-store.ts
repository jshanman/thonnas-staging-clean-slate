import type { ReleaseReceipt } from './receipt';

// @intent Port for receipt persist; SSM is SoR, memory is for unit tests

export class ReceiptAlreadyExistsError extends Error {
  readonly name = 'ParameterAlreadyExists';

  constructor(releaseId: string) {
    super(`Release receipt ${releaseId} already exists`);
  }
}

export interface ReceiptStore {
  put(receipt: ReleaseReceipt, overwrite?: boolean): Promise<ReleaseReceipt>;
  get(releaseId: string): Promise<ReleaseReceipt | undefined>;
  list(): Promise<ReleaseReceipt[]>;
  supersede(releaseId: string): Promise<void>;
}

export function receiptParameterPath(project: string, env: string, releaseId: string): string {
  return `/thonnas/${project}/${env}/releases/${releaseId}`;
}

export function receiptParameterPrefix(project: string, env: string): string {
  return `/thonnas/${project}/${env}/releases/`;
}



