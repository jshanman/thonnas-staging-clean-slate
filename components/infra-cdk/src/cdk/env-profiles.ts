import { ResolvedCloudComponent } from '../types';
import { sanitizeSegment } from '../utils/path-helpers';

// @intent Derive single-AZ environment profiles; stack prefix includes sanitized git ref when provided for multi-branch deploys

export type EnvironmentCategory = 'beta' | 'beta-feat' | 'staging' | 'prod' | 'custom';

export interface EnvProfile {
  envKey: string;
  category: EnvironmentCategory;
  /** Sanitized project name for account-unique resource names (e.g. ALB target groups). */
  projectKey?: string;
  stackPrefix: string;
  /** Networking stack prefix based on networkingScope: "env" = stable (no git-tag), "git-tag" = includes git-tag, "account" = account-wide */
  networkingStackPrefix: string;
  /** Wiring stack prefix based on wiringScope: "env" = stable (no git-tag), "git-tag" = includes git-tag, "account" = account-wide */
  wiringStackPrefix: string;
  /** ComposeHost stack prefix based on composeHostScope: "env" = stable (no git-tag), "git-tag" = includes git-tag, "account" = account-wide */
  composeHostStackPrefix: string;
  enablePrivateSubnets: boolean;
  createNatGateway: boolean;
  allowFargate: boolean;
  requireAlb: boolean;
}

const toPascalCase = (value: string): string => {
  return value
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
};

export const resolveEnvCategory = (env: string): EnvironmentCategory => {
  if (env === 'beta') return 'beta';
  if (env.startsWith('beta-feat')) return 'beta-feat';
  if (env === 'staging') return 'staging';
  if (env === 'prod' || env === 'production') return 'prod';
  return 'custom';
};

/** @intent Sanitize deploy slug for CloudFormation stack names (CLI pre-validates; keep lowercase, hyphens, max 32 chars). */
export const sanitizeDeploySlug = (value?: string): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const sanitized = lower.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!sanitized) return undefined;
  return sanitized.slice(0, 32);
};

// @intent Sanitize project name for use in stack prefix (alphanumeric, hyphens allowed)
const sanitizeProjectName = (value?: string): string | undefined => {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || undefined;
};

/** Compute stack prefix based on scope: "env" = stable (no git-tag), "git-tag" = includes git-tag, "account" = account-wide */
const computeStackPrefix = (
  scope: 'env' | 'git-tag' | 'account',
  effectiveProject: string | undefined,
  sanitizedEnv: string,
  refSuffix: string,
): string => {
  if (scope === 'account') {
    return effectiveProject ? toPascalCase(effectiveProject) : 'Thonnas';
  }
  if (scope === 'env') {
    const envPart = sanitizedEnv;
    return effectiveProject ? toPascalCase(`${effectiveProject}-${envPart}`) : toPascalCase(envPart) || 'Thonnas';
  }
  // scope === 'git-tag'
  const envPart = `${sanitizedEnv}${refSuffix}`;
  return effectiveProject ? toPascalCase(`${effectiveProject}-${envPart}`) : toPascalCase(envPart) || 'Thonnas';
};

export const buildEnvProfile = (
  env: string,
  components: ResolvedCloudComponent[],
  deploySlug?: string,
  projectName?: string,
): EnvProfile => {
  const sanitizedEnv = sanitizeSegment(env) || env;
  const category = resolveEnvCategory(sanitizedEnv);
  const sanitizedRef = sanitizeDeploySlug(deploySlug);
  const refSuffix = sanitizedRef ? `-${sanitizedRef}` : '';

  const allowFargate = components.some(
    (component) =>
      component.metadata.runtimeType === 'ecs-fargate' ||
      component.construct === 'TemporalServer' ||
      component.construct === 'ObserveIngest',
  );
  const requireAlb = components.some((component) => component.metadata.routing === 'alb');

  const enablePrivateSubnets = category !== 'beta' && category !== 'beta-feat';
  const createNatGateway = enablePrivateSubnets && (category === 'prod' || category === 'staging');

  const effectiveProject = sanitizeProjectName(projectName);
  const envPart = `${sanitizedEnv}${refSuffix}`;
  const stackPrefixBase = effectiveProject ? toPascalCase(`${effectiveProject}-${envPart}`) : toPascalCase(envPart);
  const stackPrefix = stackPrefixBase || 'Thonnas';

  // @intent Read scopes from composeHost metadata (if any component uses compose-host). Default to "env" for backward compatibility.
  // When multiple components have composeHost, use the most permissive scope (git-tag > env > account) for shared stacks.
  const composeHostComponents = components.filter((c) => c.metadata.compose);
  let networkingScope: 'env' | 'git-tag' | 'account' = 'env';
  let wiringScope: 'env' | 'git-tag' | 'account' = 'env';
  let composeHostScope: 'env' | 'git-tag' | 'account' = 'env';

  if (composeHostComponents.length > 0) {
    // @intent For shared stacks (Networking/Wiring), use most restrictive scope (env > git-tag > account) so all components can share the same stack
    // Priority: env (most restrictive/shared) > git-tag > account (least restrictive)
    const allNetworkingScopes = composeHostComponents
      .map((c) => c.metadata.compose?.networkingScope ?? 'env')
      .filter((s): s is 'env' | 'git-tag' | 'account' => ['env', 'git-tag', 'account'].includes(s));
    const allWiringScopes = composeHostComponents
      .map((c) => c.metadata.compose?.wiringScope ?? 'env')
      .filter((s): s is 'env' | 'git-tag' | 'account' => ['env', 'git-tag', 'account'].includes(s));
    // @intent Use most restrictive: if any component needs env-scoped, use env (all can share); otherwise use git-tag; fallback to account
    networkingScope = allNetworkingScopes.includes('env')
      ? 'env'
      : allNetworkingScopes.includes('git-tag')
        ? 'git-tag'
        : allNetworkingScopes[0] ?? 'env';
    wiringScope = allWiringScopes.includes('env')
      ? 'env'
      : allWiringScopes.includes('git-tag')
        ? 'git-tag'
        : allWiringScopes[0] ?? 'env';
    // @intent ComposeHost scope is per-component (each component can have its own isolated ComposeHost stack)
    composeHostScope = composeHostComponents[0]?.metadata.compose?.composeHostScope ?? 'env';
  }

  return {
    envKey: sanitizedEnv,
    category,
    projectKey: effectiveProject,
    stackPrefix,
    networkingStackPrefix: computeStackPrefix(networkingScope, effectiveProject, sanitizedEnv, refSuffix),
    wiringStackPrefix: computeStackPrefix(wiringScope, effectiveProject, sanitizedEnv, refSuffix),
    composeHostStackPrefix: computeStackPrefix(composeHostScope, effectiveProject, sanitizedEnv, refSuffix),
    enablePrivateSubnets,
    createNatGateway,
    allowFargate,
    requireAlb,
  };
};




