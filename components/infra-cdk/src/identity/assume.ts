import { appendFileSync } from 'node:fs';
import {
  STSClient,
  AssumeRoleWithWebIdentityCommand,
  GetCallerIdentityCommand,
} from '@aws-sdk/client-sts';
import { loadCommittedExportDefaults } from './committed-config';

export const ROLE_ARN_ENV = 'INFRA_CDK_DEPLOY_ROLE_ARN';
export const OIDC_AUDIENCE_ENV = 'INFRA_CDK_OIDC_AUDIENCE';
export const DEFAULT_OIDC_AUDIENCE = 'sts.amazonaws.com';

export const MISSING_ROLE_CONFIG =
  'missing role config: INFRA_CDK_DEPLOY_ROLE_ARN is empty. Commit a non-secret role ARN in thonnas-config.json (identity.assume runs before config.resolve, so Secrets Manager cannot supply this).';

export const MISSING_PLATFORM_IDENTITY =
  'missing platform identity: GitHub OIDC token was not available (ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN) and the default AWS credential chain is unusable.';

export interface AssumeConfig {
  roleArn: string;
  audience: string;
  region: string;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface IdentityAssumeDeps {
  envVars: NodeJS.ProcessEnv;
  committed: Record<string, string>;
  getCallerIdentity: (region: string) => Promise<void>;
  fetchOidcToken: (requestUrl: string, requestToken: string, audience: string) => Promise<string>;
  assumeRoleWithWebIdentity: (input: {
    roleArn: string;
    webIdentityToken: string;
    audience: string;
    region: string;
    sessionName: string;
  }) => Promise<AwsCredentials>;
  persistSession: (creds: AwsCredentials, region: string, envVars: NodeJS.ProcessEnv) => void;
  log: (message: string) => void;
}

export type IdentityAssumeResult =
  | { outcome: 'oidc-assumed'; roleArn: string }
  | { outcome: 'noop-existing-credentials' };

/** @intent Merge process env over committed non-secret defaults; empty values are unset. */
export function resolveAssumeConfig(
  envVars: NodeJS.ProcessEnv,
  committed: Record<string, string>,
): AssumeConfig {
  const get = (key: string): string => {
    const fromEnv = envVars[key]?.trim();
    if (fromEnv) return fromEnv;
    return committed[key]?.trim() || '';
  };
  return {
    roleArn: get(ROLE_ARN_ENV),
    audience: get(OIDC_AUDIENCE_ENV) || DEFAULT_OIDC_AUDIENCE,
    region: get('AWS_REGION') || get('AWS_DEFAULT_REGION') || 'us-east-1',
  };
}

function githubOidcRequest(envVars: NodeJS.ProcessEnv): { url: string; token: string } | undefined {
  const url = envVars.ACTIONS_ID_TOKEN_REQUEST_URL?.trim();
  const token = envVars.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim();
  if (!url || !token) return undefined;
  return { url, token };
}

/** @intent Federate GitHub OIDC into the deploy role, or no-op when a usable AWS session already exists. */
export async function runIdentityAssume(deps: IdentityAssumeDeps): Promise<IdentityAssumeResult> {
  const config = resolveAssumeConfig(deps.envVars, deps.committed);
  const oidc = githubOidcRequest(deps.envVars);

  if (oidc) {
    if (!config.roleArn) {
      throw new Error(MISSING_ROLE_CONFIG);
    }
    deps.log(`identity.assume: exchanging GitHub OIDC token for ${ROLE_ARN_ENV}`);
    const jwt = await deps.fetchOidcToken(oidc.url, oidc.token, config.audience);
    const sessionName = `thonnas-${deps.envVars.THONNAS_ENV || 'cicd'}`
      .replace(/[^A-Za-z0-9+=,.@-]/g, '-')
      .slice(0, 64);
    const creds = await deps.assumeRoleWithWebIdentity({
      roleArn: config.roleArn,
      webIdentityToken: jwt,
      audience: config.audience,
      region: config.region,
      sessionName,
    });
    deps.persistSession(creds, config.region, deps.envVars);
    deps.log('identity.assume: obtained federated AWS session (credentials not logged)');
    return { outcome: 'oidc-assumed', roleArn: config.roleArn };
  }

  try {
    await deps.getCallerIdentity(config.region);
    deps.log('identity.assume: default AWS credential chain is usable; skipping federation (no-op)');
    return { outcome: 'noop-existing-credentials' };
  } catch {
    // fall through to distinguish missing role vs missing platform identity
  }

  if (!config.roleArn) {
    throw new Error(MISSING_ROLE_CONFIG);
  }
  throw new Error(MISSING_PLATFORM_IDENTITY);
}

/** @intent Fetch the GitHub Actions OIDC JWT for the given audience. */
export async function fetchGithubOidcToken(
  requestUrl: string,
  requestToken: string,
  audience: string,
): Promise<string> {
  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience);
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${requestToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(
      `missing platform identity: GitHub OIDC token request failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as { value?: string };
  if (!body.value) {
    throw new Error('missing platform identity: GitHub OIDC token response had no value');
  }
  return body.value;
}

/** @intent Call STS GetCallerIdentity using the default credential chain. */
export async function stsGetCallerIdentity(region: string): Promise<void> {
  const client = new STSClient({ region });
  await client.send(new GetCallerIdentityCommand({}));
}

/** @intent Call STS AssumeRoleWithWebIdentity and return temporary credentials. */
export async function stsAssumeRoleWithWebIdentity(input: {
  roleArn: string;
  webIdentityToken: string;
  audience: string;
  region: string;
  sessionName: string;
}): Promise<AwsCredentials> {
  const client = new STSClient({ region: input.region });
  const out = await client.send(
    new AssumeRoleWithWebIdentityCommand({
      RoleArn: input.roleArn,
      RoleSessionName: input.sessionName,
      WebIdentityToken: input.webIdentityToken,
      DurationSeconds: 3600,
    }),
  );
  const creds = out.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error('identity.assume: STS did not return session credentials');
  }
  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
}

/** @intent Export session for this process and GitHub Actions subsequent steps; never print secret values. */
export function persistAwsSession(
  creds: AwsCredentials,
  region: string,
  envVars: NodeJS.ProcessEnv,
): void {
  envVars.AWS_ACCESS_KEY_ID = creds.accessKeyId;
  envVars.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
  envVars.AWS_SESSION_TOKEN = creds.sessionToken;
  envVars.AWS_REGION = region;
  envVars.AWS_DEFAULT_REGION = region;

  if (envVars.GITHUB_ACTIONS === 'true') {
    console.log(`::add-mask::${creds.accessKeyId}`);
    console.log(`::add-mask::${creds.secretAccessKey}`);
    console.log(`::add-mask::${creds.sessionToken}`);
  }

  const githubEnv = envVars.GITHUB_ENV;
  if (githubEnv) {
    appendFileSync(
      githubEnv,
      [
        `AWS_ACCESS_KEY_ID=${creds.accessKeyId}`,
        `AWS_SECRET_ACCESS_KEY=${creds.secretAccessKey}`,
        `AWS_SESSION_TOKEN=${creds.sessionToken}`,
        `AWS_REGION=${region}`,
        `AWS_DEFAULT_REGION=${region}`,
        '',
      ].join('\n'),
      { encoding: 'utf8' },
    );
  }
}

/** @intent CLI entry for identity-assume: load committed config, then federate or no-op. */
export async function executeIdentityAssume(options: {
  env: string;
  componentDir: string;
  projectRoot?: string;
  envVars?: NodeJS.ProcessEnv;
}): Promise<IdentityAssumeResult> {
  const envVars = { ...(options.envVars ?? process.env), THONNAS_ENV: options.env };
  const committed = loadCommittedExportDefaults(
    options.componentDir,
    options.env,
    options.projectRoot,
  );
  return runIdentityAssume({
    envVars,
    committed,
    getCallerIdentity: stsGetCallerIdentity,
    fetchOidcToken: fetchGithubOidcToken,
    assumeRoleWithWebIdentity: stsAssumeRoleWithWebIdentity,
    persistSession: persistAwsSession,
    log: (message) => console.log(message),
  });
}

