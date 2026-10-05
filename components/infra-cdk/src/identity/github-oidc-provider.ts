import { IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GITHUB_ACTIONS_OIDC_HOST = 'token.actions.githubusercontent.com';

export function githubOidcProviderArnForAccount(accountId: string): string {
  return `arn:aws:iam::${accountId}:oidc-provider/${GITHUB_ACTIONS_OIDC_HOST}`;
}

/** @intent Pick the account-wide GitHub Actions OIDC IdP from an IAM list */
export function pickGithubOidcProviderArn(arns: string[]): string | undefined {
  const suffix = `oidc-provider/${GITHUB_ACTIONS_OIDC_HOST}`;
  return arns.find((arn) => arn.endsWith(suffix));
}

/** @intent Import GitHub's OIDC IdP when it already exists instead of creating a duplicate */
export async function lookupGithubOidcProviderArn(options?: {
  region?: string;
  listProviderArns?: () => Promise<string[]>;
}): Promise<string | undefined> {
  const arns = options?.listProviderArns
    ? await options.listProviderArns()
    : await listGithubOidcProviderArns(options?.region);
  return pickGithubOidcProviderArn(arns);
}

async function listGithubOidcProviderArns(region?: string): Promise<string[]> {
  const client = new IAMClient({ region: region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1' });
  const out = await client.send(new ListOpenIDConnectProvidersCommand({}));
  return (out.OpenIDConnectProviderList ?? [])
    .map((entry) => entry.Arn)
    .filter((arn): arn is string => Boolean(arn));
}

/** @intent GET a small JSON document over HTTPS without adding an HTTP client dependency. Sends a
 * token when one is available (private repos 404 without auth on the plain REST API) — checks the
 * env vars GitHub Actions and most CI systems already populate before falling back to unauth'd. */
function fetchJson(url: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'thonnas-infra-cdk',
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`GitHub API ${url} returned ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`GitHub API ${url} timed out`)));
  });
}

/** @intent Fallback for local/interactive use: the gh CLI resolves auth (keychain/SSO) on its
 * own, covering private repos when no GITHUB_TOKEN/GH_TOKEN env var is set. Best-effort — returns
 * undefined (never throws) so callers can fall through to their own error handling. */
async function fetchJsonViaGhCli(apiPath: string): Promise<unknown | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', apiPath], { timeout: 5000 });
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

export interface GithubNumericIds {
  orgId: string;
  repoId: string;
}

/**
 * @intent GitHub's OIDC `sub` claim for an environment-scoped job is
 * `repo:<owner>@<ownerId>/<repo>@<repoId>:environment:<env>` — the numeric ids are immutable
 * (survive org/repo renames), which is the entire point of including them; a name-only subject
 * filter will not match the real token GitHub issues. These ids are stable, so they are safe and
 * correct to resolve once and cache in project config rather than re-fetch on every synth. A
 * private repo 404s the plain REST call without auth, so this tries, in order: a token already in
 * the environment (GITHUB_TOKEN/GH_TOKEN — set by GitHub Actions and most CI systems), then the
 * `gh` CLI's own auth resolution (covers local/interactive use), before giving up.
 */
export async function resolveGithubNumericIds(org: string, repo: string): Promise<GithubNumericIds> {
  const userPath = `users/${encodeURIComponent(org)}`;
  const repoPath = `repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  let user: unknown;
  let repository: unknown;
  try {
    [user, repository] = await Promise.all([
      fetchJson(`https://api.github.com/${userPath}`),
      fetchJson(`https://api.github.com/${repoPath}`),
    ]);
  } catch (error) {
    [user, repository] = await Promise.all([fetchJsonViaGhCli(userPath), fetchJsonViaGhCli(repoPath)]);
    if (user === undefined || repository === undefined) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  const orgId = (user as { id?: number | string })?.id;
  const repoId = (repository as { id?: number | string })?.id;
  if (orgId == null || repoId == null) {
    throw new Error(`GitHub API did not return numeric ids for ${org}/${repo}`);
  }
  return { orgId: String(orgId), repoId: String(repoId) };
}

/** @intent Build the exact subject claims GitHub's real OIDC token uses (see resolveGithubNumericIds) */
export function subjectFiltersWithNumericIds(
  org: string,
  repo: string,
  ids: GithubNumericIds,
  envName: string,
): string[] {
  const subject = `${org}@${ids.orgId}/${repo}@${ids.repoId}`;
  return [`repo:${subject}:environment:${envName}`, `repo:${subject}:ref:refs/heads/${envName}`];
}

