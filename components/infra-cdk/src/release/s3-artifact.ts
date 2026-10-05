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
import type { BindingResult } from './bindings';
import type { ReleaseContext } from './context';
import { RELEASE_META_PREFIX, RELEASE_POINTER_KEY, generationPrefix, listFilesRecursive, type ReleasePointer } from './s3-cloudfront';

export interface ArtifactReleasePort {
  putObject(args: { bucket: string; key: string; body: Buffer; contentType: string }): Promise<void>;
  listKeys(bucket: string, prefix?: string): Promise<string[]>;
  copyObject(bucket: string, fromKey: string, toKey: string): Promise<void>;
  deleteObject(bucket: string, key: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<Buffer | undefined>;
}

const BUCKET_KEYS = ['bucket', 'websiteBucket', 's3WebsiteBucket', 'bucketName'];

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

// @intent Live objects live under extras.prefix (default env), not the website root
export function resolveArtifactLivePrefix(ctx: ReleaseContext): string {
  const extras = ctx.extras ?? {};
  const prefix =
    (typeof extras.prefix === 'string' && extras.prefix.trim()) ||
    ctx.env ||
    'staging';
  return prefix.replace(/^\/+|\/+$/g, '');
}

export function resolveArtifactBucket(ctx: ReleaseContext): string | undefined {
  return firstString(ctx.extras, BUCKET_KEYS) ?? firstString(loadGeneratedOverlay(ctx), BUCKET_KEYS);
}

// @intent Collect real payload files from extras paths under packageDir
export function collectArtifactSourceFiles(ctx: ReleaseContext): string[] {
  const extras = ctx.extras ?? {};
  const dir = ctx.packageDir;
  if (!dir) return [];
  const files: string[] = [];
  const rawPaths: string[] = [];
  if (Array.isArray(extras.artifactPaths)) {
    for (const item of extras.artifactPaths) {
      if (typeof item === 'string' && item.trim()) rawPaths.push(item.trim());
    }
  }
  if (typeof extras.artifactPath === 'string' && extras.artifactPath.trim()) {
    rawPaths.push(extras.artifactPath.trim());
  }
  for (const rel of rawPaths) {
    const full = path.isAbsolute(rel) ? rel : path.join(dir, rel);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) files.push(...listFilesRecursive(full));
    else files.push(full);
  }
  if (files.length === 0 && typeof extras.outputPath === 'string' && extras.outputPath.trim()) {
    files.push(...listFilesRecursive(path.join(dir, extras.outputPath.trim())));
  }
  if (files.length === 0) {
    files.push(...listFilesRecursive(path.join(dir, 'dist')));
  }
  return files;
}

function fail(message: string): BindingResult {
  return { ok: false, kind: 'unknown', binding: 's3-artifact', message };
}

function newGenerationId(ctx: ReleaseContext): string {
  const tag = ctx.imageTag?.trim();
  if (tag && tag !== 'latest') return tag.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `rel-${Date.now()}`;
}

async function readPointer(port: ArtifactReleasePort, bucket: string): Promise<ReleasePointer | undefined> {
  const raw = await port.getObject(bucket, RELEASE_POINTER_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as ReleasePointer;
  } catch {
    return undefined;
  }
}

async function writePointer(port: ArtifactReleasePort, bucket: string, pointer: ReleasePointer): Promise<void> {
  await port.putObject({
    bucket,
    key: RELEASE_POINTER_KEY,
    body: Buffer.from(JSON.stringify(pointer), 'utf8'),
    contentType: 'application/json',
  });
}

function liveKey(livePrefix: string, rel: string): string {
  return `${livePrefix}/${rel}`;
}

async function listLiveKeys(
  port: ArtifactReleasePort,
  bucket: string,
  livePrefix: string,
): Promise<string[]> {
  const keys = await port.listKeys(bucket, `${livePrefix}/`);
  return keys.filter((key) => key.startsWith(`${livePrefix}/`) && !key.startsWith(`${RELEASE_META_PREFIX}/`));
}

// @intent Copy a generation onto extras.prefix without deleting generation objects
async function promoteGeneration(
  port: ArtifactReleasePort,
  bucket: string,
  generationId: string,
  livePrefix: string,
): Promise<string[]> {
  const prefix = generationPrefix(generationId);
  const genKeys = (await port.listKeys(bucket, prefix)).filter((key) => key.startsWith(prefix));
  const relative = genKeys.map((key) => key.slice(prefix.length)).filter(Boolean);
  for (const rel of relative) {
    await port.copyObject(bucket, `${prefix}${rel}`, liveKey(livePrefix, rel));
  }
  const liveKeys = await listLiveKeys(port, bucket, livePrefix);
  const keep = new Set(relative.map((rel) => liveKey(livePrefix, rel)));
  for (const key of liveKeys) {
    if (!keep.has(key)) {
      await port.deleteObject(bucket, key);
    }
  }
  return relative;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function createAwsPort(region: string): ArtifactReleasePort {
  const s3 = new S3Client({ region });
  return {
    async putObject({ bucket, key, body, contentType }) {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async listKeys(bucket, prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const out = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const item of out.Contents ?? []) {
          if (item.Key) keys.push(item.Key);
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async copyObject(bucket, fromKey, toKey) {
      await s3.send(
        new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${fromKey}`, Key: toKey }),
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

function sourceRel(file: string, roots: string[]): string {
  for (const root of roots) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  }
  return path.basename(file);
}

// @intent Upload a generation then promote it onto extras.prefix
export async function releaseS3Artifact(
  ctx: ReleaseContext,
  port?: ArtifactReleasePort,
): Promise<BindingResult> {
  const bucket = resolveArtifactBucket(ctx);
  const livePrefix = resolveArtifactLivePrefix(ctx);
  const files = collectArtifactSourceFiles(ctx);
  if (!bucket) {
    return fail(
      's3-artifact release requires extras.bucket (or websiteBucket / s3WebsiteBucket) or the same field in generated endpoints.',
    );
  }
  if (!ctx.packageDir) {
    return fail('s3-artifact release requires a package directory.');
  }
  if (files.length === 0) {
    return fail(
      's3-artifact release found no payload. Pass extras.artifactPath / artifactPaths / outputPath with real files (do not tag-swap an empty apply bucket).',
    );
  }
  const region =
    (typeof ctx.extras?.bucket_region === 'string' && ctx.extras.bucket_region) ||
    process.env.AWS_REGION ||
    'us-east-1';
  const client = port ?? createAwsPort(region);
  const pointer = await readPointer(client, bucket);
  const previousId = pointer?.id ?? null;
  const releaseId = newGenerationId(ctx);
  const prefix = generationPrefix(releaseId);
  const roots = [
    typeof ctx.extras?.outputPath === 'string' ? path.join(ctx.packageDir, ctx.extras.outputPath) : '',
    path.join(ctx.packageDir, 'dist'),
    ctx.packageDir,
  ].filter(Boolean);
  for (const file of files) {
    const rel = sourceRel(file, roots);
    await client.putObject({
      bucket,
      key: `${prefix}${rel}`,
      body: fs.readFileSync(file),
      contentType: contentTypeFor(file),
    });
  }
  const promoted = await promoteGeneration(client, bucket, releaseId, livePrefix);
  await writePointer(client, bucket, {
    schemaVersion: 1,
    id: releaseId,
    previousId,
    createdAt: new Date().toISOString(),
  });
  return {
    ok: true,
    kind: 'released',
    binding: 's3-artifact',
    from: previousId,
    to: releaseId,
    message: `Published generation ${releaseId} (${promoted.length} file(s)) to s3://${bucket}/${livePrefix}.`,
  };
}

// @intent Restore the previous generation; fail-closed if none (leave live)
export async function rollbackS3Artifact(
  ctx: ReleaseContext,
  port?: ArtifactReleasePort,
): Promise<BindingResult> {
  const bucket = resolveArtifactBucket(ctx);
  const livePrefix = resolveArtifactLivePrefix(ctx);
  if (!bucket) {
    return fail(
      's3-artifact rollback requires extras.bucket (or websiteBucket / s3WebsiteBucket) or the same field in generated endpoints.',
    );
  }
  const region =
    (typeof ctx.extras?.bucket_region === 'string' && ctx.extras.bucket_region) ||
    process.env.AWS_REGION ||
    'us-east-1';
  const client = port ?? createAwsPort(region);
  const pointer = await readPointer(client, bucket);
  const targetId = ctx.restoreGenerationId?.trim() || pointer?.previousId || null;
  if (!targetId) {
    return fail('s3-artifact rollback found no previous generation. Live artifacts stay.');
  }
  const restored = await promoteGeneration(client, bucket, targetId, livePrefix);
  await writePointer(client, bucket, {
    schemaVersion: 1,
    id: targetId,
    previousId: pointer?.id === targetId ? null : pointer?.id ?? null,
    createdAt: new Date().toISOString(),
  });
  return {
    ok: true,
    kind: 'released',
    binding: 's3-artifact',
    from: pointer?.id ?? null,
    to: targetId,
    message: `Rolled back s3://${bucket}/${livePrefix} to generation ${targetId} (${restored.length} file(s)).`,
  };
}



