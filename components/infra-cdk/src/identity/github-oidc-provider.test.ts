import { describe, expect, it } from '@jest/globals';
import {
  githubOidcProviderArnForAccount,
  pickGithubOidcProviderArn,
  lookupGithubOidcProviderArn,
} from './github-oidc-provider';

describe('github-oidc-provider', () => {
  it('builds the canonical GitHub OIDC provider ARN', () => {
    expect(githubOidcProviderArnForAccount('686354460141')).toBe(
      'arn:aws:iam::686354460141:oidc-provider/token.actions.githubusercontent.com',
    );
  });

  it('picks the GitHub Actions provider and ignores others', () => {
    expect(
      pickGithubOidcProviderArn([
        'arn:aws:iam::1:oidc-provider/accounts.google.com',
        'arn:aws:iam::1:oidc-provider/token.actions.githubusercontent.com',
      ]),
    ).toBe('arn:aws:iam::1:oidc-provider/token.actions.githubusercontent.com');
    expect(pickGithubOidcProviderArn(['arn:aws:iam::1:oidc-provider/accounts.google.com'])).toBeUndefined();
  });

  it('looks up via injected list so tests stay offline', async () => {
    const found = await lookupGithubOidcProviderArn({
      listProviderArns: async () => ['arn:aws:iam::9:oidc-provider/token.actions.githubusercontent.com'],
    });
    expect(found).toBe('arn:aws:iam::9:oidc-provider/token.actions.githubusercontent.com');
  });
});

