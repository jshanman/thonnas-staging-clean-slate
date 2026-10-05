/**
 * Lambda handler: on S3 PutObject to a versioned key ({prefix}/{version}/artifact-{version}-{platform}-{arch}),
 * copy the object to {prefix}/latest/artifact-latest-{platform}-{arch} so "latest" URLs work without a JSON lookup.
 * Also supports explicit invoke with { bucket, prefix?, keys: string[] } so apply can trigger copy after upload.
 * Component-agnostic: no hardcoded artifact names; key shape is derived from the upload pattern.
 * @intent Copy versioned S3 artifact to latest path on upload for install script compatibility
 */

import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

// Three segments: prefix/version/filename e.g. beta/0.1.4/mycli-0.1.4-linux-x64
const KEY_3_REGEX = /^(.+)\/([^/]+)\/(.+)-([^/]+)-([a-z0-9]+-[a-z0-9]+)(\.exe)?$/i;
// Two segments: version/filename e.g. 0.1.4/mycli-0.1.4-linux-x64 (dest: prefix/latest/ or latest/)
const KEY_2_REGEX = /^([^/]+)\/(.+)-([^/]+)-([a-z0-9]+-[a-z0-9]+)(\.exe)?$/i;

interface S3Record {
  s3: {
    bucket: { name: string };
    object: { key: string };
  };
}

interface S3Event {
  Records?: S3Record[];
}

/** Custom invoke from apply script: copy these keys to latest/ */
interface CopyLatestRequest {
  bucket: string;
  /** Optional; used when keys have only two segments (version/filename) to build prefix/latest/ */
  prefix?: string;
  keys: string[];
}

type HandlerEvent = S3Event | CopyLatestRequest;

function isCopyLatestRequest(event: HandlerEvent): event is CopyLatestRequest {
  return Array.isArray((event as CopyLatestRequest).keys) && typeof (event as CopyLatestRequest).bucket === 'string';
}

function parseKey(key: string): { prefix: string; destFilename: string } | null {
  const decoded = decodeURIComponent(key);
  // Three segments: prefix/version/filename -> prefix/latest/base-latest-platformArch.ext
  const m3 = decoded.match(KEY_3_REGEX);
  if (m3) {
    const [, prefix, , baseName, , platformArch, ext] = m3;
    return {
      prefix,
      destFilename: `${baseName}-latest-${platformArch}${ext ?? ''}`,
    };
  }
  // Two segments: version/filename -> prefix/latest/base-latest-platformArch.ext (prefix from request or "latest")
  const m2 = decoded.match(KEY_2_REGEX);
  if (m2) {
    const [, , baseName, , platformArch, ext] = m2;
    const destFilename = `${baseName}-latest-${platformArch}${ext ?? ''}`;
    return { prefix: 'latest', destFilename };
  }
  return null;
}

export async function handler(event: HandlerEvent): Promise<{ copied: number; errors: string[] }> {
  const errors: string[] = [];
  let copied = 0;

  type Entry = { bucket: string; key: string; destKey: string };
  const entries: Entry[] = [];

  if (isCopyLatestRequest(event)) {
    const req = event as CopyLatestRequest;
    const prefixOverride = req.prefix;
    for (const key of req.keys) {
      const parsed = parseKey(key);
      if (!parsed) {
        errors.push(`Key not versioned pattern: ${key}`);
        continue;
      }
      const destPrefix = prefixOverride && parsed.prefix === 'latest' ? prefixOverride : parsed.prefix;
      const destKey =
        destPrefix === 'latest' ? `latest/${parsed.destFilename}` : `${destPrefix}/latest/${parsed.destFilename}`;
      entries.push({ bucket: req.bucket, key, destKey });
    }
  } else {
    for (const record of event.Records ?? []) {
      const bucket = record.s3?.bucket?.name;
      const key = record.s3?.object?.key ?? '';
      if (!bucket || !key) {
        errors.push('Missing bucket or key in record');
        continue;
      }
      const parsed = parseKey(key);
      if (!parsed) continue;
      const destKey =
        parsed.prefix === 'latest' ? `latest/${parsed.destFilename}` : `${parsed.prefix}/latest/${parsed.destFilename}`;
      entries.push({ bucket, key, destKey });
    }
  }

  for (const { bucket, key, destKey } of entries) {
    // CopySource must be URL-encoded for SDK v3
    const copySource = encodeURIComponent(`${bucket}/${decodeURIComponent(key)}`);

    try {
      await s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: copySource,
          Key: destKey,
        }),
      );
      copied += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Copy ${key} -> ${destKey}: ${msg}`);
    }
  }

  if (errors.length > 0) {
    console.error('CopyToLatest errors:', errors);
  }
  return { copied, errors };
}



