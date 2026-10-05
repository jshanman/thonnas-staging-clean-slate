import fs from 'node:fs/promises';
import path from 'node:path';

/** Used when no --root-domain, THONNAS_ROOT_DOMAIN, or thonnas.root_domain is set. */
export const FALLBACK_ROOT_DOMAIN = 'example.local';

/** Matches thonnas-secrets.json internal secret that stores the compose-host git PAT/password. */
export const DEFAULT_GIT_PASSWORD_SECRET_NAME = 'GIT_CLONE_PASSWORD';

interface ThonnasPackageJson {
  name?: string;
  thonnas?: {
    root_domain?: string;
  };
}

const readThonnasPackageJson = async (projectRoot: string): Promise<ThonnasPackageJson | undefined> => {
  try {
    const pkgPath = path.join(projectRoot, 'thonnas-package.json');
    const contents = await fs.readFile(pkgPath, 'utf8');
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
};

// @intent Read default root domain from thonnas-package.json when available
export const readRootDomainFromThonnasPackage = async (projectRoot: string): Promise<string | undefined> => {
  const pkg = await readThonnasPackageJson(projectRoot);
  const rootDomain = pkg?.thonnas?.root_domain;
  if (typeof rootDomain === 'string' && rootDomain.trim().length > 0) {
    return rootDomain.trim();
  }
  return undefined;
};

// @intent Resolve project name for stack prefix: env var > project/config.json > root thonnas-package.json name
export const resolveProjectName = async (projectRoot: string, env: string): Promise<string | undefined> => {
  if (process.env.THONNAS_PROJECT_NAME?.trim()) {
    return process.env.THONNAS_PROJECT_NAME.trim();
  }
  try {
    const configPath = path.join(projectRoot, 'project', 'config.json');
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as Record<string, Record<string, string>>;
    const envConfig = config[env] ?? config.default ?? config;
    const name = envConfig?.THONNAS_PROJECT_NAME ?? config.default?.THONNAS_PROJECT_NAME;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {
    // missing or invalid project/config.json — fall through to thonnas-package.json
  }
  const pkg = await readThonnasPackageJson(projectRoot);
  const name = pkg?.name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return undefined;
};




