import {
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { ReleaseReceipt } from './receipt';
import {
  ReceiptAlreadyExistsError,
  receiptParameterPath,
  receiptParameterPrefix,
  type ReceiptStore,
} from './receipt-store';

// @intent Persist receipts in SSM; PutParameter creates the key (no apply stack)

export interface SsmReceiptStoreOptions {
  project: string;
  env: string;
  region: string;
  client?: SSMClient;
}

function parseReceipt(value: string | undefined, name: string): ReleaseReceipt {
  if (!value) {
    throw new Error(`SSM parameter ${name} has an empty receipt`);
  }
  const parsed = JSON.parse(value) as ReleaseReceipt;
  if (parsed.schemaVersion !== 1 || typeof parsed.releaseId !== 'string') {
    throw new Error(`SSM parameter ${name} is not a v1 release receipt`);
  }
  return parsed;
}

export class SsmReceiptStore implements ReceiptStore {
  private readonly project: string;
  private readonly env: string;
  private readonly client: SSMClient;

  constructor(options: SsmReceiptStoreOptions) {
    this.project = options.project;
    this.env = options.env;
    this.client = options.client ?? new SSMClient({ region: options.region });
  }

  async put(receipt: ReleaseReceipt, overwrite = false): Promise<ReleaseReceipt> {
    const name = receiptParameterPath(this.project, this.env, receipt.releaseId);
    try {
      await this.client.send(
        new PutParameterCommand({
          Name: name,
          Type: 'String',
          Value: JSON.stringify(receipt),
          Overwrite: overwrite,
        }),
      );
    } catch (error) {
      const nameOf =
        error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
      if (nameOf === 'ParameterAlreadyExists') {
        throw new ReceiptAlreadyExistsError(receipt.releaseId);
      }
      throw error;
    }
    return receipt;
  }

  async get(releaseId: string): Promise<ReleaseReceipt | undefined> {
    const name = receiptParameterPath(this.project, this.env, releaseId);
    try {
      const result = await this.client.send(new GetParameterCommand({ Name: name }));
      return parseReceipt(result.Parameter?.Value, name);
    } catch (error) {
      const nameOf =
        error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
      if (nameOf === 'ParameterNotFound') {
        return undefined;
      }
      throw error;
    }
  }

  async list(): Promise<ReleaseReceipt[]> {
    const prefix = receiptParameterPrefix(this.project, this.env);
    const receipts: ReleaseReceipt[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new GetParametersByPathCommand({
          Path: prefix,
          Recursive: false,
          NextToken: nextToken,
        }),
      );
      for (const parameter of page.Parameters ?? []) {
        if (!parameter.Name || !parameter.Value) continue;
        receipts.push(parseReceipt(parameter.Value, parameter.Name));
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return receipts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async supersede(releaseId: string): Promise<void> {
    const current = await this.get(releaseId);
    if (!current) {
      throw new Error(`Unknown release id ${releaseId}`);
    }
    await this.put({ ...current, status: 'superseded' }, true);
  }
}



