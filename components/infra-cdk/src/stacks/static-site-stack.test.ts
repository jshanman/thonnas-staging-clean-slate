import { describe, expect, it } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { createCdkApp } from '../cdk/runtime';
import { DependencyGraph, PlannedResource, ResolvedCloudComponent } from '../types';
import { ArtifactStack } from './artifact-stack';
import { StaticSiteStack, buildViewerRequestFunctionCode } from './static-site-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const hzDomain = 'example.test';
const websiteDomain = 'staging.fixture-web.example.test';
const certArn = 'arn:aws:acm:us-east-1:123456789012:certificate/4878cbd0-7604-478d-b9b0-63b40407a72b';

const emptyGraph = (): DependencyGraph => ({ environment: 'staging', nodes: [], edges: [] });

const fixtureWeb: ResolvedCloudComponent = {
  id: 'staging-fixture-web',
  component: 'fixture-web',
  env: 'staging',
  strategy: 'website',
  construct: 'StaticSite',
  scope: 'service',
  requires: [],
  metadata: {},
};

const fixtureCli: ResolvedCloudComponent = {
  id: 'staging-fixture-cli',
  component: 'fixture-cli',
  env: 'staging',
  strategy: 'artifact',
  construct: 'ArtifactDeploy',
  scope: 'service',
  requires: [],
  metadata: {},
};

function planned(kind: PlannedResource['kind'], props: Record<string, unknown>, component = 'fixture-web'): PlannedResource {
  return {
    id: `${kind}-${component}`,
    kind,
    env: 'staging',
    scope: 'service',
    component,
    props,
  };
}

function hostedZoneContext(): Record<string, object> {
  return {
    [`hosted-zone:account=${env.account}:domainName=${hzDomain}:privateZone=false`]: {
      Id: '/hostedzone/ZTESTSTATIC',
      Name: `${hzDomain}.`,
    },
  };
}

function issuedCertContext(): Record<string, string> {
  return {
    [`ThonnasCertArn:${websiteDomain}`]: certArn,
    [`ThonnasCertStatus:${websiteDomain}`]: 'ISSUED',
  };
}

const cookieGate = {
  type: 'frontend-cookie-gate',
  cookieName: 'site_gate',
  cookieValue: 'accepted-v1',
  challengePath: '/gate',
};

describe('StaticSiteStack', () => {
  it('emits CloudFront only when the cert is ISSUED', () => {
    const app = new App({
      context: {
        ...hostedZoneContext(),
        ...issuedCertContext(),
      },
    });
    const stack = new StaticSiteStack(app, 'LiveFeat001Stagingfixture-webStaticSite', {
      env,
      profile: buildEnvProfile('staging', []),
      component: fixtureWeb,
      resources: [
        planned('s3WebsiteBucket', { bucket: 'fixture-web-origin', website_domain: websiteDomain, hosted_zone_domain: hzDomain }),
        planned('s3StaticSiteDeployment', {
          website_domain: websiteDomain,
          hosted_zone_domain: hzDomain,
          outputPath: 'build',
        }),
      ],
    });
    expect(stack.stackName.endsWith('StaticSite')).toBe(true);
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('Custom::CDKBucketDeployment', 0);
  });

  it('imports leftover distribution and skips a second A record', () => {
    const app = new App({
      context: {
        ...hostedZoneContext(),
        ...issuedCertContext(),
        [`ThonnasBucketExists:live-feat001-ts1-fixture-web-550536272394`]: 'true',
        [`ThonnasDistributionId:${websiteDomain}`]: 'E28JR7QV9UJOCG',
        [`ThonnasDistributionDomainName:${websiteDomain}`]: 'd111111abcdef8.cloudfront.net',
        [`ThonnasSkipStaticSiteAlias:${websiteDomain}`]: 'true',
      },
    });
    const stack = new StaticSiteStack(app, 'LiveFeat001Stagingfixture-webStaticSite', {
      env,
      profile: buildEnvProfile('staging', []),
      component: fixtureWeb,
      resources: [
        planned('s3WebsiteBucket', {
          bucket: 'live-feat001-ts1-fixture-web-550536272394',
          website_domain: websiteDomain,
          hosted_zone_domain: hzDomain,
        }),
        planned('s3StaticSiteDeployment', {
          website_domain: websiteDomain,
          hosted_zone_domain: hzDomain,
        }),
      ],
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  it('emits a CloudFront Function when cookie-gate extras are declared', () => {
    const app = new App({
      context: {
        ...hostedZoneContext(),
        ...issuedCertContext(),
      },
    });
    const stack = new StaticSiteStack(app, 'LiveFeat001Stagingfixture-webStaticSite', {
      env,
      profile: buildEnvProfile('staging', []),
      component: fixtureWeb,
      resources: [
        planned('s3WebsiteBucket', { bucket: 'fixture-web-origin', website_domain: websiteDomain, hosted_zone_domain: hzDomain }),
        planned('s3StaticSiteDeployment', {
          website_domain: websiteDomain,
          hosted_zone_domain: hzDomain,
          accessControl: cookieGate,
        }),
      ],
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::Function', 1);
    const code = buildViewerRequestFunctionCode(cookieGate);
    expect(code).toContain('site_gate');
    expect(code).toContain('/gate');
  });

  it('fails closed when website_domain or hosted_zone_domain is missing', () => {
    const app = new App();
    expect(
      () =>
        new StaticSiteStack(app, 'MissingDomainStaticSite', {
          env,
          profile: buildEnvProfile('staging', []),
          component: fixtureWeb,
          resources: [planned('s3StaticSiteDeployment', { outputPath: 'build' })],
        }),
    ).toThrow(/website_domain and hosted_zone_domain/);
  });
});

describe('createCdkApp static vs artifact emit', () => {
  it('artifact-only app has zero CloudFront and no StaticSite stack', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: {
        components: [fixtureCli],
        resources: [planned('s3ArtifactDeployment', { bucket: 'cli-binaries' }, 'fixture-cli')],
      },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
      projectRoot: '/tmp/artifact-only',
    });
    const stacks = app.node.findAll().filter((node) => node instanceof Stack) as Stack[];
    expect(stacks.some((stack) => stack.stackName.endsWith('StaticSite'))).toBe(false);
    expect(stacks.some((stack) => stack.stackName.endsWith('Artifact'))).toBe(true);
    for (const stack of stacks) {
      const template = Template.fromStack(stack);
      expect(template.findResources('AWS::CloudFront::Distribution')).toEqual({});
    }
  });

  it('static-site app has CloudFront only on a stack id ending StaticSite', () => {
    const app = createCdkApp({
      env: 'staging',
      graph: emptyGraph(),
      resolution: {
        components: [fixtureWeb],
        resources: [
          planned('s3WebsiteBucket', {
            bucket: 'fixture-web-origin',
            website_domain: websiteDomain,
            hosted_zone_domain: hzDomain,
          }),
          planned('s3StaticSiteDeployment', {
            website_domain: websiteDomain,
            hosted_zone_domain: hzDomain,
          }),
        ],
      },
      imageTag: 'latest',
      accountId: env.account,
      region: env.region,
      cdkContext: {
        ...hostedZoneContext(),
        ...issuedCertContext(),
      },
    });
    const stacks = app.node.findAll().filter((node) => node instanceof Stack) as Stack[];
    expect(stacks.some((stack) => stack.stackName.endsWith('Artifact'))).toBe(false);
    const staticStack = stacks.find((stack) => stack.stackName.endsWith('StaticSite'));
    expect(staticStack).toBeDefined();
    const staticTemplate = Template.fromStack(staticStack!);
    staticTemplate.resourceCountIs('AWS::CloudFront::Distribution', 1);
    for (const stack of stacks) {
      if (stack === staticStack) continue;
      expect(Template.fromStack(stack).findResources('AWS::CloudFront::Distribution')).toEqual({});
    }
    expect(staticStack instanceof ArtifactStack).toBe(false);
    expect(staticStack instanceof StaticSiteStack).toBe(true);
  });
});



