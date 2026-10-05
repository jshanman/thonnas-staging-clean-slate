import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { ComposeHostStack, buildComposeHostUserData } from './compose-host-stack';
import { ResolvedCloudComponent } from '../types';

const env = { account: '123456789012', region: 'us-east-1' };

const fixtureComposeHost = (): ResolvedCloudComponent => ({
  id: 'beta-fixture-api',
  component: 'fixture-api',
  env: 'beta',
  strategy: 'compose-host',
  construct: 'ComposeHostEc2',
  scope: 'service',
  requires: [],
  metadata: {
    compose: {
      gitRepositoryUrl: 'https://example.invalid/acme/thonnas-project.git',
      branch: 'main',
      composeFile: 'docker-compose.yml',
      workingDirectory: '/opt/thonnas-app',
      publishedServices: [],
    },
  },
});

describe('ComposeHostStack', () => {
  it('sets a CreationPolicy resource signal on the instance so infra apply waits for readiness', () => {
    const app = new App();
    const profile = buildEnvProfile('beta', []);
    const networking = new NetworkingStack(app, 'NetCompose', { env, profile, maxAzs: 2 });
    const stack = new ComposeHostStack(app, 'Compose', {
      env,
      profile,
      networking,
      component: fixtureComposeHost(),
      config: {
        gitRepositoryUrl: 'https://example.invalid/acme/thonnas-project.git',
        branch: 'main',
        composeFile: 'docker-compose.yml',
        workingDirectory: '/opt/thonnas-app',
        publishedServices: [],
      },
    });
    const template = Template.fromStack(stack);
    const instances = template.findResources('AWS::EC2::Instance');
    const [instance] = Object.values(instances) as Array<{ CreationPolicy?: unknown }>;
    expect(instance.CreationPolicy).toEqual({
      ResourceSignal: { Count: 1, Timeout: 'PT15M' },
    });
  });

  it('grants the instance role permission to signal this stack and read its own tags', () => {
    const app = new App();
    const profile = buildEnvProfile('beta', []);
    const networking = new NetworkingStack(app, 'NetComposePerm', { env, profile, maxAzs: 2 });
    const stack = new ComposeHostStack(app, 'ComposePerm', {
      env,
      profile,
      networking,
      component: fixtureComposeHost(),
      config: {
        gitRepositoryUrl: 'https://example.invalid/acme/thonnas-project.git',
        branch: 'main',
        composeFile: 'docker-compose.yml',
        workingDirectory: '/opt/thonnas-app',
        publishedServices: [],
      },
    });
    const blob = JSON.stringify(Template.fromStack(stack).toJSON());
    expect(blob).toMatch(/cloudformation:SignalResource/);
    expect(blob).toMatch(/ec2:DescribeTags/);
  });
});

describe('buildComposeHostUserData readiness signal', () => {
  it('reports SUCCESS or FAILURE via a trap so a stuck/failed boot does not hang infra apply forever', () => {
    const commands = buildComposeHostUserData({
      workingDirectory: '/opt/thonnas-app',
      gitRepositoryUrl: 'https://example.invalid/acme/thonnas-project.git',
      composeFile: 'docker-compose.yml',
      tag: 'main',
      envFileLines: ['THONNAS_ENV=beta'],
      gitPasswordSecretName: 'infra-cdk/beta/GIT_CLONE_PASSWORD',
      thonnasEnv: 'beta',
      region: 'us-east-1',
    });
    const script = commands.join('\n');
    expect(script).toMatch(/trap on_exit EXIT/);
    expect(script).toMatch(/signal_cfn SUCCESS/);
    expect(script).toMatch(/signal_cfn FAILURE/);
    expect(script).toMatch(/aws cloudformation signal-resource/);
    expect(script).toMatch(/aws:cloudformation:logical-id/);
    // @intent Never hang on an unreachable IMDS endpoint (e.g. in a non-EC2 sandbox)
    expect(script).toMatch(/curl -s --max-time 3 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http:\/\/169\.254\.169\.254\/latest\/api\/token/);
    // @intent IMDSv2 can be account-default even when the CDK construct doesn't request it; a
    // token-less v1-style call then gets a silent empty 401, not a hang or visible error.
    expect(script).toMatch(/-H "X-aws-ec2-metadata-token: \$IMDS_TOKEN"/);
    // @intent CloudFormation's own ec2:CreateTags call for aws:cloudformation:* tags is not
    // ordered against user-data start, so a bare single lookup can race and find nothing yet --
    // resolve_cfn_tag must retry, not just try once and give up.
    expect(script).toMatch(/resolve_cfn_tag\(\) \{/);
    expect(script).toMatch(/while \[ "\$attempt" -lt 10 \]/);
  });
});

