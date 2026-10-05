import fs from 'node:fs';
import path from 'node:path';
import {
  GetAliasCommand,
  GetFunctionCommand,
  LambdaClient,
  PublishVersionCommand,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
} from '@aws-sdk/client-lambda';
import type { BindingResult } from './bindings';
import type { ReleaseContext } from './context';
import { SIGNED_URL_ALIAS } from '../stacks/signed-url-stack';

export interface LambdaAliasPort {
  updateFunctionCode(functionName: string, zip: Buffer): Promise<void>;
  waitFunctionUpdated(functionName: string): Promise<void>;
  publishVersion(functionName: string): Promise<string>;
  updateAlias(functionName: string, alias: string, version: string): Promise<void>;
  getAlias(functionName: string, alias: string): Promise<{ functionVersion: string } | undefined>;
}

const FUNCTION_KEYS = ['functionName', 'function', 'lambdaFunctionName'];

function firstString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function loadGeneratedOverlay(ctx: ReleaseContext): Record<string, unknown> | undefined {
  const candidates = [
    ctx.packageDir ? path.join(ctx.packageDir, 'generated', 'thonnas-config.generated.json') : '',
    ctx.packageDir ? path.join(ctx.packageDir, 'generated', `${ctx.env}.endpoints.json`) : '',
  ].filter(Boolean);
  for (const filePath of candidates) {
    const doc = readJsonObject(filePath);
    if (doc) return doc;
  }
  return undefined;
}

// @intent Resolve function name from extras or generated endpoints — never guess workshop names
export function resolveLambdaFunctionName(ctx: ReleaseContext): string | undefined {
  return firstString(ctx.extras, FUNCTION_KEYS) ?? firstString(loadGeneratedOverlay(ctx), FUNCTION_KEYS);
}

export function resolveLambdaAliasName(ctx: ReleaseContext): string {
  const extras = ctx.extras ?? {};
  if (typeof extras.alias === 'string' && extras.alias.trim()) return extras.alias.trim();
  return SIGNED_URL_ALIAS;
}

export function resolveHandlerPath(ctx: ReleaseContext): string | undefined {
  const extras = ctx.extras ?? {};
  const rel =
    (typeof extras.handlerPath === 'string' && extras.handlerPath.trim()) || 'src/handler.js';
  if (!ctx.packageDir) return undefined;
  const full = path.isAbsolute(rel) ? rel : path.join(ctx.packageDir, rel);
  return fs.existsSync(full) ? full : undefined;
}

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return ~crc >>> 0;
}

// @intent Pack one index.js so UpdateFunctionCode can accept ZipFile
export function zipSingleFile(filename: string, body: Buffer): Buffer {
  const name = Buffer.from(filename, 'utf8');
  const crc = crc32(body);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + body.length, 16);
  return Buffer.concat([local, body, central, end]);
}

function fail(message: string): BindingResult {
  return { ok: false, kind: 'unknown', binding: 'lambda-alias', message };
}

function createAwsPort(region: string): LambdaAliasPort {
  const lambda = new LambdaClient({ region });
  return {
    async updateFunctionCode(functionName, zip) {
      await lambda.send(
        new UpdateFunctionCodeCommand({ FunctionName: functionName, ZipFile: zip }),
      );
    },
    // @intent Wait until UpdateFunctionCode is Successful before PublishVersion
    async waitFunctionUpdated(functionName) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const out = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
        const status = out.Configuration?.LastUpdateStatus;
        if (status === 'Successful') return;
        if (status === 'Failed') {
          throw new Error(`UpdateFunctionCode failed for ${functionName}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`lambda-alias wait timed out waiting for ${functionName} to finish updating.`);
    },
    async publishVersion(functionName) {
      const out = await lambda.send(new PublishVersionCommand({ FunctionName: functionName }));
      if (!out.Version) throw new Error('PublishVersion returned no Version.');
      return out.Version;
    },
    async updateAlias(functionName, alias, version) {
      await lambda.send(
        new UpdateAliasCommand({
          FunctionName: functionName,
          Name: alias,
          FunctionVersion: version,
        }),
      );
    },
    async getAlias(functionName, alias) {
      const out = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: alias }));
      return out.FunctionVersion ? { functionVersion: out.FunctionVersion } : undefined;
    },
  };
}

async function waitAlias(
  port: LambdaAliasPort,
  functionName: string,
  alias: string,
  version: string,
  wait: boolean,
): Promise<void> {
  if (!wait) return;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await port.getAlias(functionName, alias);
    if (current?.functionVersion === version) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`lambda-alias wait timed out waiting for ${alias} to reach version ${version}.`);
}

function shouldWait(ctx: ReleaseContext): boolean {
  return ctx.extras?.['deploy.wait'] !== false;
}

// @intent Publish a new version and point alias live (all-at-once)
export async function releaseLambdaAlias(
  ctx: ReleaseContext,
  port?: LambdaAliasPort,
): Promise<BindingResult> {
  const functionName = resolveLambdaFunctionName(ctx);
  const handlerPath = resolveHandlerPath(ctx);
  const alias = resolveLambdaAliasName(ctx);
  if (!functionName) {
    return fail(
      'lambda-alias release requires extras.functionName (or generated endpoints). Do not guess a workshop name.',
    );
  }
  if (!handlerPath) {
    return fail(
      'lambda-alias release requires extras.handlerPath (default src/handler.js) with a real file under the package dir.',
    );
  }
  const region =
    (typeof ctx.extras?.bucket_region === 'string' && ctx.extras.bucket_region) ||
    process.env.AWS_REGION ||
    'us-east-1';
  const client = port ?? createAwsPort(region);
  const previous = await client.getAlias(functionName, alias);
  const previousVersion = previous?.functionVersion ?? null;
  const zip = zipSingleFile('index.js', fs.readFileSync(handlerPath));
  await client.updateFunctionCode(functionName, zip);
  await client.waitFunctionUpdated(functionName);
  const version = await client.publishVersion(functionName);
  await client.updateAlias(functionName, alias, version);
  await waitAlias(client, functionName, alias, version, shouldWait(ctx));
  return {
    ok: true,
    kind: 'released',
    binding: 'lambda-alias',
    from: previousVersion,
    to: version,
    message: `Published Lambda version ${version} and pointed alias ${alias} on ${functionName}.`,
  };
}

// @intent Flip alias to the receipt from version; do not rebuild
export async function rollbackLambdaAlias(
  ctx: ReleaseContext,
  port?: LambdaAliasPort,
): Promise<BindingResult> {
  const functionName = resolveLambdaFunctionName(ctx);
  const alias = resolveLambdaAliasName(ctx);
  if (!functionName) {
    return fail(
      'lambda-alias rollback requires extras.functionName (or generated endpoints). Do not guess a workshop name.',
    );
  }
  const region =
    (typeof ctx.extras?.bucket_region === 'string' && ctx.extras.bucket_region) ||
    process.env.AWS_REGION ||
    'us-east-1';
  const client = port ?? createAwsPort(region);
  const current = await client.getAlias(functionName, alias);
  const target = ctx.restoreGenerationId?.trim() || null;
  if (!target) {
    return fail('lambda-alias rollback found no previous version. Live alias stays.');
  }
  await client.updateAlias(functionName, alias, target);
  await waitAlias(client, functionName, alias, target, shouldWait(ctx));
  return {
    ok: true,
    kind: 'released',
    binding: 'lambda-alias',
    from: current?.functionVersion ?? null,
    to: target,
    message: `Rolled back alias ${alias} on ${functionName} to version ${target}.`,
  };
}



