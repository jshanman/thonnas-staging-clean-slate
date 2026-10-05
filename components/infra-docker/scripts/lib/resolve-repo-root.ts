/**
 * @intent Resolve Thonnas project root consistent with the Thonnas CLI.
 * Project root = monorepo root with .thonnas and components/. No override flag; inferred from cwd.
 * With dev-link, run thonnas from the target repo (where the symlink lives); do not run from the worktree.
 *
 * Resolution order (matches CLI):
 * 1. THONNAS_PROJECT_ROOT env (set by CLI for thonnas build / run / infra)
 * 2. Walk up from process.cwd(): prefer dir with both .thonnas and components/, else .thonnas, else components/
 * 3. Fallback: two levels up from scriptDir (components/infra-docker/scripts/)
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

function hasThonnasDir(dir: string): boolean {
  return existsSync(path.join(dir, '.thonnas'));
}

function hasComponentsDir(dir: string): boolean {
  return existsSync(path.join(dir, 'components'));
}

/**
 * Walk up from startDir to find project root using CLI rules.
 * Preferred: both .thonnas and components/. Otherwise: first ancestor with .thonnas or components/. Else stop at cwd.
 */
function walkUpToProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  let candidate: string | null = null;
  while (dir !== root) {
    const hasT = hasThonnasDir(dir);
    const hasC = hasComponentsDir(dir);
    if (hasT && hasC) return dir;
    if ((hasT || hasC) && candidate === null) candidate = dir;
    dir = path.dirname(dir);
  }
  return candidate ?? path.resolve(startDir);
}

/**
 * Returns the absolute path to the Thonnas project root.
 * Use THONNAS_PROJECT_ROOT when set (e.g. by CLI); else infer by walking up from cwd (same as CLI).
 */
export function resolveRepoRoot(scriptDir: string): string {
  const envRoot = process.env.THONNAS_PROJECT_ROOT?.trim();
  if (envRoot) {
    const absolute = path.resolve(envRoot);
    if (hasThonnasDir(absolute) || hasComponentsDir(absolute)) {
      return absolute;
    }
  }

  const fromCwd = walkUpToProjectRoot(process.cwd());
  if (hasThonnasDir(fromCwd) || hasComponentsDir(fromCwd)) {
    return fromCwd;
  }

  return path.resolve(scriptDir, '..', '..');
}

