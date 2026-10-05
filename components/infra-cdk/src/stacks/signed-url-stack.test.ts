import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildEnvProfile } from '../cdk/env-profiles';
import { PlannedResource, ResolvedCloudComponent } from '../types';
import {
  SIGNED_URL_ALIAS,
  SignedUrlStack,
  mergeSignedUrlEnvironment,
  resolveDeclaringComponentLockfile,
  signedUrlFunctionName,
} from './signed-url-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const hzDomain = 'example.test';
const apiDomain = 'staging.fixture-signed-url.example.test';

const fixtureComponent = (name: string): ResolvedCloudComponent => ({
  id: `staging-${name}`,
  component: name,
  env: 'staging',
  strategy: 'storage-temp-url',
  construct: 'StorageTempUrlApi',
  scope: 'service',
  requires: [],
  metadata: {},
});

function planned(
  component: string,
  props: Record<string, unknown>,
): PlannedResource {
  return {
    id: `storage-temp-url-staging-${component}`,
    kind: 'storageTempUrlApi',
    env: 'staging',
    scope: 'service',
    component,
    props: {
      bucket: 'fixture-signed-url-bucket',
      prefix: 'staging',
      api_domain: apiDomain,
      hosted_zone_domain: hzDomain,
      handlerPath: 'src/handler.js',
      ...props,
    },
  };
}

function writeFixtureComponent(root: string, name: string, withHandler: boolean, withLock: boolean): void {
  const dir = path.join(root, 'components', name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  if (withHandler) {
    fs.writeFileSync(
      path.join(dir, 'src', 'handler.js'),
      'exports.handler = async () => ({ statusCode: 200, body: "{}" });\n',
    );
  }
  if (withLock) {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0' }),
    );
    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({
        name,
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name } },
      }),
    );
  }
}

describe('SignedUrlStack', () => {
  it('stack id ends with SignedUrl', () => {
    const id = 'LiveFeat001Stagingfixture-signed-urlSignedUrl';
    expect(id.endsWith('SignedUrl')).toBe(true);
  });

  it('merges generic STORAGE_* with one-phase artifact fallback', () => {
    const envMap = mergeSignedUrlEnvironment({
      bucket: 'b',
      prefix: 'p',
      bucketRegion: 'us-east-1',
      extrasEnv: { CUSTOM: 'yes', STORAGE_PREFIX: 'override' },
    });
    expect(envMap.STORAGE_BUCKET).toBe('b');
    expect(envMap.STORAGE_PREFIX).toBe('override');
    expect(envMap.STORAGE_BUCKET_REGION).toBe('us-east-1');
    expect(envMap.THONNAS_ARTIFACT_BUCKET).toBe('b');
    expect(envMap.THONNAS_ARTIFACT_PREFIX).toBe('p');
    expect(envMap.THONNAS_ARTIFACT_BUCKET_REGION).toBe('us-east-1');
    expect(envMap.CUSTOM).toBe('yes');
  });

  it('resolves lockfile from the declaring component directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-url-lock-'));
    try {
      writeFixtureComponent(root, 'fixture-signed-url', true, true);
      const resolved = resolveDeclaringComponentLockfile(root, 'fixture-signed-url');
      expect(resolved.depsLockFilePath).toBe(
        path.join(root, 'components', 'fixture-signed-url', 'package-lock.json'),
      );
      expect(resolved.depsLockFilePath.includes(`${path.sep}infra-cdk${path.sep}`)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws when declaring component lockfile is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-url-nolock-'));
    try {
      writeFixtureComponent(root, 'fixture-signed-url', true, false);
      expect(() => resolveDeclaringComponentLockfile(root, 'fixture-signed-url')).toThrow(
        /infra.api.storage-temp-url/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('synths placeholder + live alias without app handler or lockfile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-url-synth-'));
    try {
      const app = new App({
        context: {
          [`hosted-zone:account=${env.account}:domainName=${hzDomain}:privateZone=false`]: {
            Id: '/hostedzone/ZTESTSIGNEDURL',
            Name: `${hzDomain}.`,
          },
        },
      });
      const stack = new SignedUrlStack(app, 'LiveFeat001Stagingfixture-signed-urlSignedUrl', {
        env,
        profile: buildEnvProfile('staging', []),
        component: fixtureComponent('fixture-signed-url'),
        projectRoot: root,
        resources: [planned('fixture-signed-url', { bucket_region: 'us-east-2' })],
      });
      expect(stack.stackName.endsWith('SignedUrl')).toBe(true);
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::CloudFront::Distribution', 0);
      const fns = template.findResources('AWS::Lambda::Function');
      const envVars = Object.values(fns).map(
        (fn) =>
          (fn as { Properties?: { Environment?: { Variables?: Record<string, string> } } }).Properties
            ?.Environment?.Variables ?? {},
      );
      expect(envVars.some((vars) => vars.STORAGE_BUCKET === 'fixture-signed-url-bucket')).toBe(true);
      expect(envVars.some((vars) => vars.THONNAS_ARTIFACT_BUCKET === 'fixture-signed-url-bucket')).toBe(
        true,
      );
      expect(envVars.some((vars) => vars.STORAGE_PREFIX === 'staging')).toBe(true);
      expect(envVars.some((vars) => vars.THONNAS_ARTIFACT_PREFIX === 'staging')).toBe(true);
      const blob = JSON.stringify(template.toJSON());
      expect(blob).toContain(SIGNED_URL_ALIAS);
      expect(blob).toContain('not released');
      expect(blob).toContain(signedUrlFunctionName('staging', 'fixture-signed-url'));
      expect(Object.keys(template.findResources('AWS::Lambda::Url')).length).toBeGreaterThan(0);
      expect(Object.keys(template.findResources('AWS::Lambda::Alias')).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not list a generic compute.function strategy', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'thonnas-package.json'), 'utf8'),
    ) as { thonnas?: { implements_strategies?: string[] } };
    const keys = pkg.thonnas?.implements_strategies ?? [];
    expect(keys).toContain('infra.api.storage-temp-url');
    expect(keys).not.toContain('infra.compute.function');
  });
});



