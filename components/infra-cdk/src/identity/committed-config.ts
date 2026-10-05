import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface CommittedExport {
  name: string;
  default?: unknown;
  defaultByEnv?: Record<string, unknown>;
}

interface ThonnasConfigFile {
  exports?: CommittedExport[];
}

/** @intent Overlay consuming-project config so assume can read role ARN before config.resolve. */
function overlayProjectConfig(
  out: Record<string, string>,
  projectRoot: string,
  envName: string,
): void {
  const configPath = path.join(projectRoot, 'project', 'config.json');
  if (!existsSync(configPath)) return;
  let parsed: { default?: Record<string, unknown>; [env: string]: unknown };
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      default?: Record<string, unknown>;
      [env: string]: unknown;
    };
  } catch {
    return;
  }
  const apply = (block: unknown) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return;
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      const text = stringifyNonEmpty(value);
      if (text !== undefined) out[key] = text;
    }
  };
  apply(parsed.default);
  apply(parsed[envName]);
}

/** @intent Read non-secret export defaults from committed thonnas-config.json (no Secrets Manager). */
export function loadCommittedExportDefaults(
  componentDir: string,
  envName: string,
  projectRoot?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const configPath = path.join(componentDir, 'thonnas-config.json');
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as ThonnasConfigFile;
    for (const entry of parsed.exports ?? []) {
      if (!entry?.name) continue;
      const resolved = resolveExportDefault(entry, envName);
      if (resolved !== undefined) {
        out[entry.name] = resolved;
      }
    }
  }
  const root = projectRoot || process.env.THONNAS_PROJECT_ROOT?.trim();
  if (root) overlayProjectConfig(out, root, envName);
  return out;
}

/** @intent Resolve defaultByEnv[env] → defaultByEnv.default → default; empty string is unset. */
export function resolveExportDefault(entry: CommittedExport, envName: string): string | undefined {
  const byEnv = entry.defaultByEnv;
  if (byEnv && typeof byEnv === 'object') {
    if (envName in byEnv) {
      return stringifyNonEmpty(byEnv[envName]);
    }
    if ('default' in byEnv) {
      return stringifyNonEmpty(byEnv.default);
    }
  }
  return stringifyNonEmpty(entry.default);
}

function stringifyNonEmpty(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.trim() === '' ? undefined : text;
}

