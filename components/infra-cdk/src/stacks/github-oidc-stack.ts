import { CfnOutput, CfnResource, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GithubOidcStackProps extends StackProps {
  envName: string;
  githubOrg: string;
  githubRepo: string;
  audience: string;
  /** GitHub `sub` claim patterns (StringLike). */
  subjectFilters: string[];
  /** When set, import an existing GitHub OIDC provider instead of creating one. */
  existingProviderArn?: string;
  /**
   * EC2 Name-tag values this role may run SSM RunShellScript commands against (e.g. a
   * compose-host instance's Name tag), so a release script assuming this same role can act on
   * already-provisioned instances. Component-agnostic by design: the caller computes these tags
   * from whichever resolved components actually need it (see runtime.ts), so this construct never
   * hardcodes a component name or project convention. Empty/omitted grants no SSM access.
   */
  ssmTargetNameTags?: string[];
}

/** @intent Trust GitHub Actions OIDC for this repo/env and grant deploy + Secrets Manager read. */
export class GithubOidcStack extends Stack {
  public readonly deployRole: iam.Role;

  public readonly provider: iam.IOpenIdConnectProvider;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    // @intent Keep the account-wide GitHub IdP when this stack is destroyed
    if (props.existingProviderArn) {
      this.provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        'GithubProvider',
        props.existingProviderArn,
      );
    } else {
      const created = new iam.OpenIdConnectProvider(this, 'GithubProvider', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      });
      retainOpenIdConnectProvider(created);
      this.provider = created;
    }

    const subjects = props.subjectFilters.length > 0
      ? props.subjectFilters
      : [
          `repo:${props.githubOrg}/${props.githubRepo}:environment:${props.envName}`,
          `repo:${props.githubOrg}/${props.githubRepo}:ref:refs/heads/${props.envName}`,
        ];

    this.deployRole = new iam.Role(this, 'GithubDeployRole', {
      description: `Thonnas GitHub deploy role for env ${props.envName}`,
      assumedBy: new iam.FederatedPrincipal(
        this.provider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': props.audience,
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': subjects,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    // @intent Least-privilege-ish deploy: CDK/app services + Secrets Manager read for config.resolve (not AdministratorAccess)
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CdkAndWorkloadDeploy',
        actions: [
          'cloudformation:*',
          's3:*',
          'ecr:*',
          'ecs:*',
          'ec2:*',
          'elasticloadbalancing:*',
          'logs:*',
          'route53:*',
          'acm:*',
          'cloudfront:*',
          'lambda:*',
          'iam:GetRole',
          'iam:PassRole',
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:AttachRolePolicy',
          'iam:DetachRolePolicy',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:TagRole',
          'iam:UntagRole',
          'iam:CreatePolicy',
          'iam:DeletePolicy',
          'iam:GetPolicy',
          'iam:GetPolicyVersion',
          'iam:ListAttachedRolePolicies',
          'iam:ListRolePolicies',
          'sts:AssumeRole',
          'sts:GetCallerIdentity',
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:GetParametersByPath',
          'ssm:PutParameter',
        ],
        resources: ['*'],
      }),
    );

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ConfigResolveSecrets',
        actions: [
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
          'secretsmanager:ListSecrets',
        ],
        resources: ['*'],
      }),
    );

    // @intent Let a release script assuming this same federated role run remote commands on
    // already-provisioned instances (e.g. thonnas release's SSM-based compose-host rollout),
    // scoped by Name tag rather than a fixed instance id so it keeps working across a
    // `thonnas infra apply` instance replacement. Tag-scoping (not a blanket grant) so this
    // doesn't become a general "run anything anywhere" capability.
    if (props.ssmTargetNameTags && props.ssmTargetNameTags.length > 0) {
      this.deployRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'RunShellScriptDocument',
          actions: ['ssm:SendCommand'],
          resources: [`arn:${Stack.of(this).partition}:ssm:*::document/AWS-RunShellScript`],
        }),
      );
      this.deployRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'SendCommandToTaggedInstances',
          actions: ['ssm:SendCommand'],
          resources: [`arn:${Stack.of(this).partition}:ec2:*:${Stack.of(this).account}:instance/*`],
          conditions: {
            StringEquals: { 'ssm:resourceTag/Name': props.ssmTargetNameTags },
          },
        }),
      );
      this.deployRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadCommandInvocationResults',
          actions: ['ssm:GetCommandInvocation'],
          resources: ['*'],
        }),
      );
    }

    new CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Commit this value as INFRA_CDK_DEPLOY_ROLE_ARN in thonnas-config.json',
    });
    new CfnOutput(this, 'GithubOidcProviderArn', {
      value: this.provider.openIdConnectProviderArn,
      description: 'Optional INFRA_CDK_OIDC_PROVIDER_ARN when the account already has a GitHub OIDC IdP',
    });
  }
}

/** @intent Default GitHub sub claims: environment jobs and pushes to the env-named branch. */
export function defaultGithubSubjectFilters(org: string, repo: string, envName: string): string[] {
  return [
    `repo:${org}/${repo}:environment:${envName}`,
    `repo:${org}/${repo}:ref:refs/heads/${envName}`,
  ];
}

// @intent Retain the custom resource; L2 OpenIdConnectProvider has no CfnResource defaultChild
function retainOpenIdConnectProvider(provider: iam.OpenIdConnectProvider): void {
  for (const child of provider.node.findAll()) {
    if (
      CfnResource.isCfnResource(child) &&
      child.cfnResourceType === 'Custom::AWSCDKOpenIdConnectProvider'
    ) {
      child.applyRemovalPolicy(RemovalPolicy.RETAIN);
    }
  }
}

