import { describe, expect, it, afterEach, jest } from '@jest/globals';
import { createCdkApp } from './runtime';
import { DependencyGraph, StrategyResolutionResult } from '../types';

const emptyGraph: DependencyGraph = { environment: 'beta', nodes: [], edges: [] };

const emptyResolution: StrategyResolutionResult = { components: [], resources: [] };

const oidcResolution: StrategyResolutionResult = {
  components: [],
  resources: [
    {
      id: 'github-oidc-beta',
      kind: 'githubOidcIdentity',
      env: 'beta',
      scope: 'shared',
      component: 'cicd-github-actions',
      props: { issuer: 'github' },
    },
  ],
};

describe('createCdkApp OIDC from infra.identity.oidc', () => {
  const prevOrg = process.env.INFRA_CDK_GITHUB_ORG;
  const prevRepo = process.env.INFRA_CDK_GITHUB_REPO;
  const prevProvider = process.env.INFRA_CDK_OIDC_PROVIDER_ARN;

  afterEach(() => {
    if (prevOrg === undefined) delete process.env.INFRA_CDK_GITHUB_ORG;
    else process.env.INFRA_CDK_GITHUB_ORG = prevOrg;
    if (prevRepo === undefined) delete process.env.INFRA_CDK_GITHUB_REPO;
    else process.env.INFRA_CDK_GITHUB_REPO = prevRepo;
    if (prevProvider === undefined) delete process.env.INFRA_CDK_OIDC_PROVIDER_ARN;
    else process.env.INFRA_CDK_OIDC_PROVIDER_ARN = prevProvider;
  });

  it('does not synthesize GithubOidc when org/repo are set but identity is not planned', () => {
    process.env.INFRA_CDK_GITHUB_ORG = 'acme';
    process.env.INFRA_CDK_GITHUB_REPO = 'thonnas-cli';
    const app = createCdkApp({
      env: 'beta',
      graph: emptyGraph,
      resolution: emptyResolution,
      imageTag: 'latest',
      accountId: '111111111111',
      region: 'us-east-1',
      projectName: 'TestProj',
    });
    expect(app.node.children.some((child) => child.node.id.includes('GithubOidc'))).toBe(false);
  });

  it('synthesizes GithubOidc when githubOidcIdentity is planned', () => {
    process.env.INFRA_CDK_GITHUB_ORG = 'acme';
    process.env.INFRA_CDK_GITHUB_REPO = 'thonnas-cli';
    const app = createCdkApp({
      env: 'beta',
      graph: emptyGraph,
      resolution: oidcResolution,
      imageTag: 'latest',
      accountId: '111111111111',
      region: 'us-east-1',
      projectName: 'TestProj',
    });
    expect(app.node.children.some((child) => child.node.id.includes('GithubOidc'))).toBe(true);
  });

  it('skips GithubOidc (warns, does not throw) when identity is planned but org/repo are unresolved', () => {
    delete process.env.INFRA_CDK_GITHUB_ORG;
    delete process.env.INFRA_CDK_GITHUB_REPO;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let app: ReturnType<typeof createCdkApp> | undefined;
    expect(() => {
      app = createCdkApp({
        env: 'beta',
        graph: emptyGraph,
        resolution: oidcResolution,
        imageTag: 'latest',
        accountId: '111111111111',
        region: 'us-east-1',
        projectName: 'TestProj',
      });
    }).not.toThrow();
    expect(app!.node.children.some((child) => child.node.id.includes('GithubOidc'))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping GithubOidc stack'));
    warnSpy.mockRestore();
  });

  it('resolveGithubOidcProviderArnForSynth uses a configured ARN without calling IAM', async () => {
    const { resolveGithubOidcProviderArnForSynth } = await import('./runtime');
    process.env.INFRA_CDK_OIDC_PROVIDER_ARN =
      'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com';
    await expect(
      resolveGithubOidcProviderArnForSynth({
        env: 'beta',
        graph: emptyGraph,
        resolution: oidcResolution,
        imageTag: 'latest',
        accountId: '111111111111',
        region: 'us-east-1',
      }),
    ).resolves.toBe('arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com');
  });
});

