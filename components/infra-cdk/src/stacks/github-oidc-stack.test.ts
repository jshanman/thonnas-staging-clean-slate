import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from '@jest/globals';
import { GithubOidcStack, defaultGithubSubjectFilters } from './github-oidc-stack';

describe('GithubOidcStack', () => {
  it('creates an OIDC provider and a role trusted for this repo/env', () => {
    const app = new App();
    const stack = new GithubOidcStack(app, 'TestGithubOidc', {
      envName: 'beta',
      githubOrg: 'acme',
      githubRepo: 'thonnas-cli',
      audience: 'sts.amazonaws.com',
      subjectFilters: defaultGithubSubjectFilters('acme', 'thonnas-cli', 'beta'),
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
    template.hasResource('Custom::AWSCDKOpenIdConnectProvider', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              },
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  'repo:acme/thonnas-cli:environment:beta',
                  'repo:acme/thonnas-cli:ref:refs/heads/beta',
                ],
              },
            },
          }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
          }),
        ]),
      }),
    });
    expect(JSON.stringify(template.toJSON())).toContain('DeployRoleArn');
  });

  it('imports an existing provider when an ARN is supplied', () => {
    const app = new App();
    const stack = new GithubOidcStack(app, 'TestGithubOidcImport', {
      envName: 'beta',
      githubOrg: 'acme',
      githubRepo: 'thonnas-cli',
      audience: 'sts.amazonaws.com',
      subjectFilters: defaultGithubSubjectFilters('acme', 'thonnas-cli', 'beta'),
      existingProviderArn:
        'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com',
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    template.resourceCountIs('AWS::IAM::Role', 1);
  });
});

