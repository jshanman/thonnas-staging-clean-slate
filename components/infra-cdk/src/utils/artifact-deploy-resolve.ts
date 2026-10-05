// @intent Shared logic for resolving artifact-deploy version and file paths (used by artifact-stack and plan summary)
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface VersionMatchConfig {
  versionFile: string;
  versionField: string;
}

export interface ArtifactDeployProps {
  artifactPath?: string;
  /** When set, resolve each template and merge paths (used instead of artifactPath). */
  artifactPaths?: string[];
  versionMatch?: VersionMatchConfig;
  [key: string]: unknown;
}

export interface ArtifactDeployUploadPlan {
  version: string;
  paths: string[];
}

const PLATFORM_ARCH_PAIRS: Array<[string, string]> = [
  ['linux', 'x64'],
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['win32', 'x64'],
];

/** Default version fallback when versionMatch is not set (read from package files in component root). */
export function readVersionFromComponent(projectRoot: string, component: string): string {
  const componentDir = path.join(projectRoot, 'components', component);
  for (const pkgFile of ['thonnas-package.json', 'package.json']) {
    const pkgPath = path.join(componentDir, pkgFile);
    try {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const data = JSON.parse(raw) as { version?: string; thonnas?: { version?: string } };
      const v = data.version ?? data.thonnas?.version;
      if (typeof v === 'string') return v;
    } catch {
      // continue
    }
  }
  return '0.0.0';
}

/** Resolve version from versionMatch (component-relative file/field) when set, else fallback. */
export function resolveVersion(
  projectRoot: string,
  component: string,
  props: ArtifactDeployProps,
): string {
  const versionMatch = props?.versionMatch;
  if (
    versionMatch &&
    typeof versionMatch.versionFile === 'string' &&
    typeof versionMatch.versionField === 'string'
  ) {
    const componentDir = path.join(projectRoot, 'components', component);
    const versionFilePath = path.join(componentDir, versionMatch.versionFile);
    try {
      const raw = fs.readFileSync(versionFilePath, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      const v = data[versionMatch.versionField];
      if (typeof v === 'string') return v;
    } catch {
      // fall through to fallback
    }
  }
  return readVersionFromComponent(projectRoot, component);
}

/** Resolve artifactPath template to existing file paths; expand {{platform}}/{{arch}} when present. {{project_root}} = project root. */
export function resolveArtifactPaths(
  projectRoot: string,
  component: string,
  artifactPathTemplate: string,
  version: string,
): string[] {
  const versionPlaceholder = '{{version}}';
  const platformPlaceholder = '{{platform}}';
  const archPlaceholder = '{{arch}}';

  const hasPlatformArch =
    artifactPathTemplate.includes(platformPlaceholder) && artifactPathTemplate.includes(archPlaceholder);

  const resolvedProjectRoot = path.resolve(projectRoot);
  const relativeTemplate = artifactPathTemplate
    .replace(/\{\{project_root\}\}/g, '')
    .replace(/\{\{repo_root\}\}/g, '') // backward compatibility
    .replace(/^[/\\]+/, '')
    .replace(versionPlaceholder, version);

  const out: string[] = [];
  if (hasPlatformArch) {
    for (const [platform, arch] of PLATFORM_ARCH_PAIRS) {
      let segment = relativeTemplate.replace(platformPlaceholder, platform).replace(archPlaceholder, arch);
      if (platform === 'win32' && !segment.toLowerCase().endsWith('.exe')) {
        segment += '.exe';
      }
      let candidate = path.join(resolvedProjectRoot, segment);
      if (!fs.existsSync(candidate)) {
        const componentDistCandidate = path.join(resolvedProjectRoot, 'components', component, segment);
        if (fs.existsSync(componentDistCandidate)) {
          candidate = componentDistCandidate;
        }
      }
      if (fs.existsSync(candidate)) {
        out.push(candidate);
      }
    }
  } else {
    let candidate = path.join(resolvedProjectRoot, relativeTemplate);
    if (!fs.existsSync(candidate)) {
      const componentDistCandidate = path.join(resolvedProjectRoot, 'components', component, relativeTemplate);
      if (fs.existsSync(componentDistCandidate)) {
        candidate = componentDistCandidate;
      }
    }
    if (fs.existsSync(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Compute which version and local paths would be uploaded for an artifact-deploy resource.
 * Uses artifactPaths (array) when set, else artifactPath (single). Resolves each template and merges paths.
 * Returns null when no path template is configured; paths may be empty when no files exist yet.
 */
export function getArtifactDeployUploadPlan(
  projectRoot: string,
  component: string,
  props: ArtifactDeployProps,
): ArtifactDeployUploadPlan | null {
  const templates =
    Array.isArray(props?.artifactPaths) && props.artifactPaths.length > 0
      ? props.artifactPaths
      : typeof props?.artifactPath === 'string' && props.artifactPath.length > 0
        ? [props.artifactPath]
        : null;
  if (!templates) {
    return null;
  }
  const version = resolveVersion(projectRoot, component, props);
  const allPaths: string[] = [];
  for (const template of templates) {
    const resolved = resolveArtifactPaths(projectRoot, component, template, version);
    for (const p of resolved) {
      if (!allPaths.includes(p)) {
        allPaths.push(p);
      }
    }
  }
  return { version, paths: allPaths };
}



