import fs from 'node:fs';
import path from 'node:path';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand, ListDistributionsCommand } from '@aws-sdk/client-cloudfront';
import type { BindingResult } from './bindings';
import type { ReleaseContext } from './context';

export const RELEASE_META_PREFIX = '.thonnas-release';
export const RELEASE_POINTER_KEY = `${RELEASE_META_PREFIX}/current.json`;

export interface ReleasePointer {
  schemaVersion: 1;
  id: string;
  previousId: string | null;
  createdAt: string;
}

export interface StaticSiteReleasePort {
  putObject(args: { bucket: string; key: string; body: Buffer; contentType: string }): Promise<void>;
  invalidate?(distributionId: string): Promise<void>;
  /** Resolve CloudFront id from the site alias when extras omit distributionId. */
  lookupDistributionId?(alias: string): Promise<string | undefined>;
  listKeys(bucket: string, prefix?: string): Promise<string[]>;
  copyObject(bucket: string, fromKey: string, toKey: string): Promise<void>;
  deleteObject(bucket: string, key: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<Buffer | undefined>;
}

const BUCKET_KEYS = ['bucket', 'websiteBucket', 's3WebsiteBucket', 'bucketName'];
const DISTRIBUTION_KEYS = ['distributionId', 'cloudfrontDistributionId', 'distribution_id'];

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

// @intent Resolve bucket and distribution from extras, generated files, or website_domain alias
export function resolveStaticSiteTargets(ctx: ReleaseContext): { bucket?: string; distributionId?: string } {
  const extras = ctx.extras ?? {};
  const generated = loadGeneratedOverlay(ctx);
  const fromExtrasBucket = firstString(extras, BUCKET_KEYS);
  const fromGeneratedBucket = firstString(generated, BUCKET_KEYS);
  const fromExtrasDist = firstString(extras, DISTRIBUTION_KEYS);
  const fromGeneratedDist = firstString(generated, DISTRIBUTION_KEYS);
  // @intent Bucket equals interpolated website hostname when extras omit an explicit name
  const derivedBucket = !fromExtrasBucket && !fromGeneratedBucket ? resolveWebsiteAlias(ctx) : undefined;
  return {
    bucket: fromExtrasBucket ?? fromGeneratedBucket ?? derivedBucket,
    distributionId: fromExtrasDist ?? fromGeneratedDist,
  };
}

// @intent Join extras.outputPath to the target package dir, not repo root or cwd
export function resolveStaticSiteSourceDir(ctx: ReleaseContext): string {
  const outputPath =
    (typeof ctx.extras?.outputPath === 'string' && ctx.extras.outputPath) || 'build';
  const packageDir = ctx.packageDir;
  if (!packageDir) {
    throw new Error('Release target directory is required for s3-cloudfront.');
  }
  return path.join(packageDir, outputPath);
}

export function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml',
    '.woff2': 'font/woff2',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function generationPrefix(id: string): string {
  return `${RELEASE_META_PREFIX}/generations/${id}/`;
}

export function isLiveKey(key: string): boolean {
  return !key.startsWith(`${RELEASE_META_PREFIX}/`);
}

function newGenerationId(ctx: ReleaseContext): string {
  const tag = ctx.imageTag?.trim();
  if (tag && tag !== 'latest') return tag.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `rel-${Date.now()}`;
}

async function readPointer(port: StaticSiteReleasePort, bucket: string): Promise<ReleasePointer | undefined> {
  const raw = await port.getObject(bucket, RELEASE_POINTER_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as ReleasePointer;
  } catch {
    return undefined;
  }
}

async function writePointer(port: StaticSiteReleasePort, bucket: string, pointer: ReleasePointer): Promise<void> {
  await port.putObject({
    bucket,
    key: RELEASE_POINTER_KEY,
    body: Buffer.from(JSON.stringify(pointer), 'utf8'),
    contentType: 'application/json',
  });
}

async function listLiveKeys(port: StaticSiteReleasePort, bucket: string): Promise<string[]> {
  const keys = await port.listKeys(bucket);
  return keys.filter(isLiveKey);
}

// @intent Copy live objects into a generation prefix without changing the live tree
async function snapshotLive(
  port: StaticSiteReleasePort,
  bucket: string,
  generationId: string,
  liveKeys: string[],
): Promise<void> {
  const prefix = generationPrefix(generationId);
  for (const key of liveKeys) {
    await port.copyObject(bucket, key, `${prefix}${key}`);
  }
}

// @intent Promote a generation onto the live prefix, then drop live keys that left the generation
async function promoteGeneration(
  port: StaticSiteReleasePort,
  bucket: string,
  generationId: string,
): Promise<string[]> {
  const prefix = generationPrefix(generationId);
  const genKeys = (await port.listKeys(bucket, prefix)).filter((key) => key.startsWith(prefix));
  const relative = genKeys.map((key) => key.slice(prefix.length)).filter(Boolean);
  for (const rel of relative) {
    await port.copyObject(bucket, `${prefix}${rel}`, rel);
  }
  const liveKeys = await listLiveKeys(port, bucket);
  const keep = new Set(relative);
  for (const key of liveKeys) {
    if (!keep.has(key)) {
      await port.deleteObject(bucket, key);
    }
  }
  return relative;
}

function fail(message: string): BindingResult {
  return { ok: false, kind: 'unknown', binding: 's3-cloudfront', message };
}

function resolveSite(ctx: ReleaseContext): { bucket?: string; distributionId?: string; region: string } {
  const { bucket, distributionId } = resolveStaticSiteTargets(ctx);
  const region =
    (typeof ctx.extras?.bucket_region === 'string' && ctx.extras.bucket_region) ||
    process.env.AWS_REGION ||
    'us-east-1';
  return { bucket, distributionId, region };
}

function resolveRootZone(extras: Record<string, unknown>): string {
  const hosted = typeof extras.hosted_zone_domain === 'string' ? extras.hosted_zone_domain.trim() : '';
  const explicit = typeof extras.rootDomain === 'string' ? extras.rootDomain.trim() : '';
  const fromEnv = process.env.THONNAS_ROOT_DOMAIN?.trim() || '';
  const zone = [hosted, explicit, fromEnv].find((value) => value && !value.includes('{')) ?? '';
  if (zone) return zone;
  if (hosted.includes('{rootDomain}')) {
    const replacement = explicit || fromEnv;
    if (replacement) return hosted.replaceAll('{rootDomain}', replacement);
  }
  return explicit || fromEnv;
}

// @intent Interpolate website_domain so CloudFront lookup can match the live alias
export function resolveWebsiteAlias(ctx: ReleaseContext): string | undefined {
  const extras = ctx.extras ?? {};
  const pattern = typeof extras.website_domain === 'string' ? extras.website_domain.trim() : '';
  if (!pattern) return undefined;
  const zone = resolveRootZone(extras);
  const alias = pattern
    .replaceAll('{env}', ctx.env)
    .replaceAll('{component}', ctx.component ?? '')
    .replaceAll('{rootDomain}', zone)
    .replaceAll('{hosted_zone_domain}', zone);
  if (!alias || alias.includes('{')) return undefined;
  return alias;
}

// @intent Use extras/generated id, else look up CloudFront by alias so invalidate still runs
async function resolveDistributionIdForSite(
  ctx: ReleaseContext,
  port: StaticSiteReleasePort,
  fromTargets?: string,
): Promise<string | undefined> {
  if (fromTargets?.trim()) return fromTargets.trim();
  const alias = resolveWebsiteAlias(ctx);
  if (!alias || !port.lookupDistributionId) return undefined;
  return port.lookupDistributionId(alias);
}

// @intent Build AWS SDK port for generation copy/promote + CloudFront invalidation
export function createAwsStaticSitePort(region: string): StaticSiteReleasePort {
  const s3 = new S3Client({ region });
  const cf = new CloudFrontClient({ region: 'us-east-1' });
  return {
    async putObject({ bucket, key, body, contentType }) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async invalidate(distributionId) {
      await cf.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: {
            CallerReference: `thonnas-release-${Date.now()}`,
            Paths: { Quantity: 1, Items: ['/*'] },
          },
        }),
      );
    },
    async lookupDistributionId(alias) {
      const list = await cf.send(new ListDistributionsCommand({ MaxItems: 100 }));
      const dist = list.DistributionList?.Items?.find((item) => item.Aliases?.Items?.includes(alias));
      return dist?.Id;
    },
    async listKeys(bucket, prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const item of page.Contents ?? []) {
          if (item.Key) keys.push(item.Key);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async copyObject(bucket, fromKey, toKey) {
      await s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${fromKey}`,
          Key: toKey,
        }),
      );
    },
    async deleteObject(bucket, key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async getObject(bucket, key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!out.Body) return undefined;
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === 'NoSuchKey' || name === 'NotFound') return undefined;
        throw error;
      }
    },
  };
}

async function invalidateIfNeeded(
  port: StaticSiteReleasePort,
  distributionId: string | undefined,
): Promise<void> {
  if (distributionId && port.invalidate) {
    await port.invalidate(distributionId);
  }
}

// @intent Publish a new generation, then promote it over live (keep previous generation)
export async function releaseS3CloudFront(
  ctx: ReleaseContext,
  port?: StaticSiteReleasePort,
): Promise<BindingResult> {
  const { bucket, distributionId, region } = resolveSite(ctx);
  const sourceDir = resolveStaticSiteSourceDir(ctx);
  const files = listFilesRecursive(sourceDir);
  if (!bucket) {
    return fail(
      's3-cloudfront release requires extras.bucket (or websiteBucket / s3WebsiteBucket), the same field in generated endpoints, or website_domain + hosted_zone_domain/rootDomain so the bucket can be derived as {env}.{component}.{rootDomain}.',
    );
  }
  if (files.length === 0) {
    return fail(`Static site output not found or empty at ${sourceDir}. Build the component first.`);
  }
  const client = port ?? createAwsStaticSitePort(region);
  const distId = await resolveDistributionIdForSite(ctx, client, distributionId);
  const pointer = await readPointer(client, bucket);
  const liveKeys = await listLiveKeys(client, bucket);
  let previousId = pointer?.id ?? null;
  if (!previousId && liveKeys.length) {
    previousId = `pre-${Date.now()}`;
    await snapshotLive(client, bucket, previousId, liveKeys);
  }
  const releaseId = newGenerationId(ctx);
  const prefix = generationPrefix(releaseId);
  for (const file of files) {
    const rel = path.relative(sourceDir, file).split(path.sep).join('/');
    await client.putObject({
      bucket,
      key: `${prefix}${rel}`,
      body: fs.readFileSync(file),
      contentType: contentTypeFor(file),
    });
  }
  try {
    const promoted = await promoteGeneration(client, bucket, releaseId);
    await writePointer(client, bucket, {
      schemaVersion: 1,
      id: releaseId,
      previousId,
      createdAt: new Date().toISOString(),
    });
    await invalidateIfNeeded(client, distId);
    return {
      ok: true,
      kind: 'released',
      binding: 's3-cloudfront',
      from: previousId,
      to: releaseId,
      message: `Published generation ${releaseId} (${promoted.length} file(s)) to s3://${bucket}${distId ? ` and invalidated ${distId}` : ''}.`,
    };
  } catch (error) {
    if (previousId) {
      await promoteGeneration(client, bucket, previousId);
    }
    throw error;
  }
}

// @intent Restore the previous generation to live
export async function rollbackS3CloudFront(
  ctx: ReleaseContext,
  port?: StaticSiteReleasePort,
): Promise<BindingResult> {
  const { bucket, distributionId, region } = resolveSite(ctx);
  if (!bucket) {
    return fail(
      's3-cloudfront rollback requires extras.bucket (or websiteBucket / s3WebsiteBucket) or the same field in generated endpoints.',
    );
  }
  const client = port ?? createAwsStaticSitePort(region);
  const distId = await resolveDistributionIdForSite(ctx, client, distributionId);
  const pointer = await readPointer(client, bucket);
  // @intent Restore the receipt's from generation instead of guessing previous
  if (ctx.restoreGenerationId) {
    const restored = await promoteGeneration(client, bucket, ctx.restoreGenerationId);
    await writePointer(client, bucket, {
      schemaVersion: 1,
      id: ctx.restoreGenerationId,
      previousId: pointer?.id ?? null,
      createdAt: new Date().toISOString(),
    });
    await invalidateIfNeeded(client, distId);
    return {
      ok: true,
      kind: 'released',
      binding: 's3-cloudfront',
      from: pointer?.id ?? null,
      to: ctx.restoreGenerationId,
      message: `Rolled back s3://${bucket} to receipt generation ${ctx.restoreGenerationId} (${restored.length} file(s)).`,
    };
  }
  if (!pointer) {
    return fail('s3-cloudfront rollback found no .thonnas-release/current.json. Nothing to restore.');
  }
  if (!pointer.previousId) {
    const liveKeys = await listLiveKeys(client, bucket);
    for (const key of liveKeys) {
      await client.deleteObject(bucket, key);
    }
    await client.deleteObject(bucket, RELEASE_POINTER_KEY);
    await invalidateIfNeeded(client, distId);
    return {
      ok: true,
      kind: 'released',
      binding: 's3-cloudfront',
      from: pointer.id,
      to: '',
      message: `Rolled back first generation ${pointer.id} on s3://${bucket} (live prefix cleared).`,
    };
  }
  const restored = await promoteGeneration(client, bucket, pointer.previousId);
  await writePointer(client, bucket, {
    schemaVersion: 1,
    id: pointer.previousId,
    previousId: null,
    createdAt: new Date().toISOString(),
  });
  await invalidateIfNeeded(client, distId);
  return {
    ok: true,
    kind: 'released',
    binding: 's3-cloudfront',
    from: pointer.id,
    to: pointer.previousId,
    message: `Rolled back s3://${bucket} from ${pointer.id} to ${pointer.previousId} (${restored.length} file(s)).`,
  };
}



