import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// @intent Resolve project-root-relative paths with normalization (aligns with CLI --project-root)
export const resolveRepoPath = (projectRoot: string, ...segments: string[]): string => {
  return path.resolve(projectRoot, ...segments);
};

// @intent Sanitize identifiers to lowercase kebab-case segments
export const sanitizeSegment = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

// @intent Convert secret path to dotenv-compatible key
export const secretPathToKey = (secretPath: string): string => {
  return secretPath
    .trim()
    .replace(/[^a-zA-Z0-9/_-]/g, '_')
    .replace(/[/-]/g, '_')
    .replace(/__+/g, '_')
    .toUpperCase();
};

// @intent Build hierarchical secret path following thonnas/{env}/{component}/{secret}
export const buildSecretPath = (env: string, component: string, secretName: string): string => {
  const sanitizedEnv = sanitizeSegment(env) || env;
  const sanitizedComponent = sanitizeSegment(component) || component;
  const sanitizedSecret = sanitizeSegment(secretName) || secretName;
  return ['thonnas', sanitizedEnv, sanitizedComponent, sanitizedSecret].join('/');
};

// @intent Prefix Secrets Manager names with project so multi-project accounts do not collide
export const defaultManagedSecretName = (
  projectKey: string | undefined,
  envKey: string,
  component: string,
  kind: string,
): string => {
  const proj = (projectKey || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 32);
  const base = `${envKey}/${component}/${kind}`;
  return proj ? `${proj}/${base}` : base;
};

// @intent Namespace CW log groups by stack prefix so projects share an account safely
export const buildServiceLogGroupName = (
  stackPrefix: string,
  component: string,
  role?: string,
): string => {
  const prefix = stackPrefix.trim() || 'Thonnas';
  const base = `/thonnas/${prefix}/${component}`;
  return role ? `${base}-${role}` : base;
};

// @intent ECR name: {project}/{env}-{component} (slash like live e2efe001/…); no project → {env}-{component}
export const ecrRepositoryName = (
  env: string,
  component: string,
  projectName?: string,
): string => {
  const leaf = `${env}-${component}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const proj = (projectName || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 32);
  return proj ? `${proj}/${leaf}` : leaf;
};

// @intent Build private ECR image URI for first release after pause apply
export const ecrImageUri = (
  accountId: string,
  region: string,
  repoName: string,
  tag: string,
): string => {
  return `${accountId}.dkr.ecr.${region}.amazonaws.com/${repoName}:${tag}`;
};

const parseDotenv = (contents: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
};

// @intent A component declares "internal" thonnas-config.json entries when its own code reads a
// named runtime env var whose value is resolved from that component's own config (e.g. api-go's
// GO_ENV/LOG_LEVEL, sourced from "app.environment"/"app.logLevel"), and "imports" entries when it
// reads a cross-component config value at runtime (e.g. api-go's WORKER_MANAGER_TEMPORAL_ENDPOINT,
// sourced from worker-manager-temporal). Nothing previously injected either kind onto ECS
// containers -- only THONNAS_ENV and cross-component secrets were wired -- so a component relying
// on the declarative config/internal mechanism for anything else silently got no value at all.
// Confirmed via a live deploy: api-go's Temporal client kept dialing "localhost:7233" because
// WORKER_MANAGER_TEMPORAL_ENDPOINT was correctly resolved into api-go's own .env.staging (baked
// into the compiled Go struct's default, which nothing then overrode) but never became a real
// runtime env var, so applyEnvOverrides()'s "if v := os.Getenv(...)" check always saw an empty
// string -- the exact same class of bug already fixed for QUEUE_MQTT_INTERNAL_HOST/PORT via
// MqttFleetToEcsStack, just for a cross-component import instead of a fleet-specific edge stack.
// Only "imports" from thonnas-config.json are read here, never thonnas-secrets.json -- secrets
// have their own ECS-native injection path (release-container.ts) with proper IAM-scoped access;
// blanket-dumping a resolved secret's plaintext .env value here would bypass that entirely.
// Reads the component's own resolved config/{env} file at CDK-synth time (produced by `thonnas
// config resolve` before `infra apply` runs) and returns non-empty values for each declared
// "internal"/"imports" name, ready to inject as real container env vars. Best-effort: a component
// without thonnas-config.json, without either array, or without a generated .env.{env} file simply
// yields no entries -- this must never fail synth.
export const resolveComponentInternalEnv = (
  projectRoot: string,
  componentKey: string,
  env: string,
): Record<string, string> => {
  const result: Record<string, string> = {};
  const componentDir = path.join(projectRoot, 'components', componentKey);
  const configPath = path.join(componentDir, 'thonnas-config.json');
  if (!existsSync(configPath)) return result;

  let declaredNames: string[];
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      internal?: { name?: string }[];
      imports?: { name?: string }[];
    };
    const internalNames = (parsed.internal ?? []).map((entry) => entry?.name);
    const importNames = (parsed.imports ?? []).map((entry) => entry?.name);
    declaredNames = [...internalNames, ...importNames].filter((name): name is string => Boolean(name));
  } catch {
    return result;
  }
  if (declaredNames.length === 0) return result;

  const envFilePath = path.join(componentDir, `.env.${env}`);
  if (!existsSync(envFilePath)) return result;

  let envValues: Map<string, string>;
  try {
    envValues = parseDotenv(readFileSync(envFilePath, 'utf8'));
  } catch {
    return result;
  }

  for (const name of declaredNames) {
    const value = envValues.get(name);
    if (value) result[name] = value;
  }
  return result;
};





