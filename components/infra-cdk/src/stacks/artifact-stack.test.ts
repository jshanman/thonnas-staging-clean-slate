import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { PlannedResource, ResolvedCloudComponent } from '../types';
import { ArtifactStack } from './artifact-stack';

const env = { account: '123456789012', region: 'us-east-1' };

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

function planned(kind: PlannedResource['kind'], props: Record<string, unknown>): PlannedResource {
  return {
    id: `${kind}-fixture-web`,
    kind,
    env: 'staging',
    scope: 'service',
    component: 'fixture-web',
    props,
  };
}

describe('ArtifactStack static site apply', () => {
  it('does not emit a static-site BucketDeployment when outputPath is missing', () => {
    const app = new App();
    const stack = new ArtifactStack(app, 'FixtureWebArtifact', {
      env,
      profile: buildEnvProfile('staging', []),
      component: fixtureWeb,
      projectRoot: '/tmp/does-not-need-a-build-tree',
      resources: [
        planned('s3WebsiteBucket', { bucket: 'fixture-web-staging-origin' }),
        planned('s3StaticSiteDeployment', { outputPath: 'build' }),
      ],
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::CDKBucketDeployment', 0);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
  });

  it('does not upload static files when s3ArtifactDeployment is also planned but dist is absent', () => {
    const app = new App();
    const stack = new ArtifactStack(app, 'FixtureWebBoth', {
      env,
      profile: buildEnvProfile('staging', []),
      component: fixtureWeb,
      projectRoot: '/tmp/does-not-need-a-build-tree',
      resources: [
        planned('s3WebsiteBucket', { bucket: 'fixture-web-staging-origin' }),
        planned('s3StaticSiteDeployment', { outputPath: 'build' }),
        planned('s3ArtifactDeployment', { prefix: 'staging' }),
      ],
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::CDKBucketDeployment', 0);
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
  });

  it('artifact-only deploy never emits CloudFront', () => {
    const app = new App();
    const stack = new ArtifactStack(app, 'FixtureCliArtifact', {
      env,
      profile: buildEnvProfile('staging', []),
      component: {
        ...fixtureWeb,
        id: 'staging-fixture-cli',
        component: 'fixture-cli',
        construct: 'ArtifactDeploy',
      },
      projectRoot: '/tmp/does-not-need-a-build-tree',
      resources: [planned('s3ArtifactDeployment', { bucket: 'cli-binaries', prefix: 'staging' })],
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    template.resourceCountIs('AWS::CloudFront::Function', 0);
  });

  it('does not BucketDeploy a present dist and grants account-root write', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-dist-'));
    try {
      const dist = path.join(root, 'components', 'fixture-cli', 'dist');
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, 'app.bin'), 'bytes');
      const app = new App();
      const stack = new ArtifactStack(app, 'FixtureCliArtifactPresent', {
        env,
        profile: buildEnvProfile('staging', []),
        component: {
          ...fixtureWeb,
          id: 'staging-fixture-cli',
          component: 'fixture-cli',
          construct: 'ArtifactDeploy',
        },
        projectRoot: root,
        resources: [planned('s3ArtifactDeployment', { bucket: 'cli-binaries', prefix: 'staging' })],
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs('Custom::CDKBucketDeployment', 0);
      template.resourceCountIs('AWS::CloudFront::Distribution', 0);
      template.resourceCountIs('AWS::S3::Bucket', 1);
      const policies = template.findResources('AWS::S3::BucketPolicy');
      const blob = JSON.stringify(policies);
      expect(blob).toMatch(/s3:PutObject/);
      expect(blob).toMatch(/AccountRootPrincipal|AWS::Partition|:root/);
      const again = new App();
      const second = new ArtifactStack(again, 'FixtureCliArtifactPresent2', {
        env,
        profile: buildEnvProfile('staging', []),
        component: {
          ...fixtureWeb,
          id: 'staging-fixture-cli',
          component: 'fixture-cli',
          construct: 'ArtifactDeploy',
        },
        projectRoot: root,
        resources: [planned('s3ArtifactDeployment', { bucket: 'cli-binaries', prefix: 'staging' })],
      });
      Template.fromStack(second).resourceCountIs('Custom::CDKBucketDeployment', 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a write policy when the bucket is imported', () => {
    const app = new App({
      context: { 'ThonnasBucketExists:cli-binaries': 'true' },
    });
    const stack = new ArtifactStack(app, 'FixtureCliImported', {
      env,
      profile: buildEnvProfile('staging', []),
      component: {
        ...fixtureWeb,
        id: 'staging-fixture-cli',
        component: 'fixture-cli',
        construct: 'ArtifactDeploy',
      },
      projectRoot: '/tmp/does-not-need-a-build-tree',
      resources: [planned('s3ArtifactDeployment', { bucket: 'cli-binaries', prefix: 'staging' })],
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::S3::BucketPolicy', 1);
    expect(JSON.stringify(template.findResources('AWS::S3::BucketPolicy'))).toMatch(/s3:PutObject/);
  });
});



