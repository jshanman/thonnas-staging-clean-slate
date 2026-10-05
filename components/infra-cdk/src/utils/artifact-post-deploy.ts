/**
 * Leftover apply-time copy-to-latest. Phase 3 apply does not upload app files
 * (`artifactUploads` is empty), so this helper is not invoked for infra.artifact.deploy.
 * Release (`s3-artifact`) owns generation upload and promote.
 * @intent Do not treat apply as the artifact publish step
 */

import {
  S3Client,
  CopyObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import * as path from 'node:path';
import type { PlannedResource } from '../types';

export interface ArtifactUploadEntry {
  component: string;
  version: string;
  paths: string[];
}

/** Key pattern: prefix/version/filename e.g. beta/0.1.4/mycli-0.1.4-linux-x64 -> dest base-latest-platformArch */
const VERSIONED_FILENAME_REGEX = /^(.+)-([^/]+)-([a-z0-9]+-[a-z0-9]+)(\.exe)?$/i;
/** Source tarball: mycli-0.1.11-source.tar.gz -> mycli-latest-source.tar.gz */
const SOURCE_TARBALL_REGEX = /^(.+)-[^/]+-(source\.tar\.gz)$/i;

function destFilename(basename: string): string {
  const sourceMatch = basename.match(SOURCE_TARBALL_REGEX);
  if (sourceMatch) {
    const [, base, suffix] = sourceMatch;
    return `${base}-latest-${suffix}`;
  }
  const m = basename.match(VERSIONED_FILENAME_REGEX);
  if (!m) return basename;
  const [, base, , platformArch, ext] = m;
  return `${base}-latest-${platformArch}${ext ?? ''}`;
}

function getDeployResource(resources: PlannedResource[], component: string): PlannedResource | undefined {
  return resources.find(
    (r) => r.kind === 's3ArtifactDeployment' && r.component === component,
  );
}

function getS3RegionsToTry(deployResource: PlannedResource): string[] {
  const configuredRegion =
    (deployResource.props.bucket_region as string | undefined) ??
    (deployResource.props.region as string | undefined) ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION;
  const regions = Array.from(new Set([configuredRegion].filter(Boolean) as string[]));
  return regions.length > 0 ? regions : ['us-east-1'];
}

export async function runArtifactPostDeploy(
  projectRoot: string,
  env: string,
  artifactUploads: ArtifactUploadEntry[],
  resources: PlannedResource[],
): Promise<{ deleted: number; copied: number; errors: string[] }> {
  const errors: string[] = [];
  const deleted = 0;
  let copied = 0;

  for (const upload of artifactUploads) {
    if (upload.paths.length === 0) continue;

    const deployResource = getDeployResource(resources, upload.component);
    if (!deployResource?.props) continue;

    const bucket = deployResource.props.bucket as string | undefined;
    const parentPrefix = (deployResource.props.prefix as string | undefined) ?? env;
    const version = upload.version;
    const fullPrefix = `${parentPrefix}/${version}`;
    const regionsToTry = getS3RegionsToTry(deployResource);

    if (!bucket) {
      errors.push(`[${upload.component}] No bucket in thonnas-infra; skipping post-deploy`);
      continue;
    }

    // Copy current version -> prefix/latest/ (overwrite only; never delete latest/ first so no 404 window)
    const missingKeys: string[] = [];
    for (const srcPath of upload.paths) {
      const basename = path.basename(srcPath);
      const srcKey = `${fullPrefix}/${basename}`;
      const destName = destFilename(basename);
      const destKey = `${parentPrefix}/latest/${destName}`;
      let s3: S3Client | undefined;
      try {
        for (const region of regionsToTry) {
          const candidate = new S3Client({ region });
          try {
            await candidate.send(new HeadObjectCommand({ Bucket: bucket, Key: srcKey }));
            s3 = candidate;
            break;
          } catch {
            // Try the next likely bucket region before reporting the source key missing.
          }
        }
        if (!s3) {
          missingKeys.push(srcKey);
          continue;
        }
      } catch {
        missingKeys.push(srcKey);
        continue;
      }
      const copySource = encodeURIComponent(`${bucket}/${srcKey}`);
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
        errors.push(`Copy ${srcKey} -> ${destKey}: ${msg}`);
      }
    }
    if (missingKeys.length > 0) {
      errors.push(
        `[${upload.component}] Source keys not found (${missingKeys.length}): ${missingKeys.slice(0, 3).join(', ')}${missingKeys.length > 3 ? '...' : ''}. CDK may not have uploaded artifacts — ensure dist/ files exist at deploy time (e.g. run build before infra apply).`,
      );
    }
  }

  if (errors.length > 0) {
    errors.forEach((err) => console.error('[artifact-post-deploy]', err));
  }
  return { deleted, copied, errors };
}



