import { describe, expect, it, jest } from '@jest/globals';
import {
  MISSING_PLATFORM_IDENTITY,
  MISSING_ROLE_CONFIG,
  persistAwsSession,
  resolveAssumeConfig,
  runIdentityAssume,
  ROLE_ARN_ENV,
  type AwsCredentials,
  type IdentityAssumeDeps,
} from './assume';

const creds: AwsCredentials = {
  accessKeyId: 'ASIA_TEST',
  secretAccessKey: 'secret-test',
  sessionToken: 'token-test',
};

function deps(overrides: Partial<IdentityAssumeDeps> & { envVars: NodeJS.ProcessEnv }): IdentityAssumeDeps {
  return {
    committed: {},
    getCallerIdentity: jest.fn(async () => {
      throw new Error('no credentials');
    }),
    fetchOidcToken: jest.fn(async () => 'header.payload.sig'),
    assumeRoleWithWebIdentity: jest.fn(async () => creds),
    persistSession: jest.fn(),
    log: jest.fn(),
    ...overrides,
  };
}

describe('resolveAssumeConfig', () => {
  it('prefers process env over committed defaults', () => {
    const config = resolveAssumeConfig(
      { [ROLE_ARN_ENV]: 'arn:aws:iam::1:role/from-env', AWS_REGION: 'us-west-2' },
      { [ROLE_ARN_ENV]: 'arn:aws:iam::1:role/from-file', AWS_REGION: 'us-east-1' },
    );
    expect(config.roleArn).toBe('arn:aws:iam::1:role/from-env');
    expect(config.region).toBe('us-west-2');
    expect(config.audience).toBe('sts.amazonaws.com');
  });

  it('uses committed defaults when env is empty', () => {
    const config = resolveAssumeConfig(
      {},
      { [ROLE_ARN_ENV]: 'arn:aws:iam::1:role/committed', INFRA_CDK_OIDC_AUDIENCE: 'sts.amazonaws.com' },
    );
    expect(config.roleArn).toBe('arn:aws:iam::1:role/committed');
  });
});

describe('runIdentityAssume', () => {
  it('no-ops when the default credential chain already works', async () => {
    const getCallerIdentity = jest.fn(async () => undefined);
    const result = await runIdentityAssume(
      deps({
        envVars: {},
        getCallerIdentity,
      }),
    );
    expect(result).toEqual({ outcome: 'noop-existing-credentials' });
    expect(getCallerIdentity).toHaveBeenCalled();
  });

  it('fails with missing role config when GitHub OIDC is present but role ARN is empty', async () => {
    await expect(
      runIdentityAssume(
        deps({
          envVars: {
            ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token',
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gha-token',
          },
        }),
      ),
    ).rejects.toThrow(MISSING_ROLE_CONFIG);
  });

  it('fails with missing platform identity when role is set but OIDC env and credential chain are absent', async () => {
    await expect(
      runIdentityAssume(
        deps({
          envVars: {},
          committed: { [ROLE_ARN_ENV]: 'arn:aws:iam::1:role/deploy' },
        }),
      ),
    ).rejects.toThrow(MISSING_PLATFORM_IDENTITY);
  });

  it('assumes the role via GitHub OIDC and persists the session without returning secrets', async () => {
    const persistSession = jest.fn();
    const assumeRoleWithWebIdentity = jest.fn(async () => creds);
    const result = await runIdentityAssume(
      deps({
        envVars: {
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gha-token',
          THONNAS_ENV: 'beta',
        },
        committed: { [ROLE_ARN_ENV]: 'arn:aws:iam::1:role/deploy' },
        persistSession,
        assumeRoleWithWebIdentity,
      }),
    );
    expect(result).toEqual({ outcome: 'oidc-assumed', roleArn: 'arn:aws:iam::1:role/deploy' });
    expect(assumeRoleWithWebIdentity).toHaveBeenCalled();
    expect(persistSession).toHaveBeenCalledWith(creds, 'us-east-1', expect.any(Object));
    expect(JSON.stringify(result)).not.toContain('secret-test');
  });
});

describe('persistAwsSession', () => {
  it('writes AWS_* into process env and does not throw when GITHUB_ENV is unset', () => {
    const envVars: NodeJS.ProcessEnv = {};
    persistAwsSession(creds, 'eu-west-1', envVars);
    expect(envVars.AWS_ACCESS_KEY_ID).toBe('ASIA_TEST');
    expect(envVars.AWS_REGION).toBe('eu-west-1');
  });
});

