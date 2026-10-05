'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  candidateSecretIds,
  createSecretsProvider,
  projectPrefix,
  resolveEndpoint,
} = require('./localstackSecrets.provider.js');

describe('localstackSecrets.provider', () => {
  const prev = {
    THONNAS_PROJECT_NAME: process.env.THONNAS_PROJECT_NAME,
    INFRA_LOCALSTACK_PORT: process.env.INFRA_LOCALSTACK_PORT,
    INFRA_LOCALSTACK_HOST_ENDPOINT: process.env.INFRA_LOCALSTACK_HOST_ENDPOINT,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL,
    AWS_SECRETS_MANAGER_ENDPOINT: process.env.AWS_SECRETS_MANAGER_ENDPOINT,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses the same SecretId shapes as aws-secrets-manager', () => {
    process.env.THONNAS_PROJECT_NAME = 'Demo Proj';
    assert.deepEqual(candidateSecretIds({ componentKey: 'dbt-mongo', secretName: 'docdb', env: 'development' }), [
      'demoproj/development/dbt-mongo/docdb',
      'development/dbt-mongo/docdb',
      'dbt-mongo/development/docdb',
    ]);
  });

  it('sanitizes the project prefix', () => {
    process.env.THONNAS_PROJECT_NAME = 'Feat 001 Slate!';
    assert.equal(projectPrefix(), 'feat001slate');
  });

  it('resolves the host LocalStack endpoint, not the compose DNS name', () => {
    delete process.env.INFRA_LOCALSTACK_HOST_ENDPOINT;
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_SECRETS_MANAGER_ENDPOINT;
    process.env.INFRA_LOCALSTACK_PORT = '4566';
    assert.equal(resolveEndpoint(), 'http://127.0.0.1:4566');
    process.env.AWS_ENDPOINT_URL = 'http://infra-localstack:4566';
    assert.equal(resolveEndpoint(), 'http://127.0.0.1:4566');
    process.env.INFRA_LOCALSTACK_HOST_ENDPOINT = 'http://127.0.0.1:14566';
    assert.equal(resolveEndpoint(), 'http://127.0.0.1:14566');
  });

  it('is writable for development and local only', () => {
    const provider = createSecretsProvider({ projectRoot: process.cwd() });
    assert.equal(provider.id, 'localstack-secrets-manager');
    assert.equal(provider.priority, 250);
    assert.equal(provider.supportsEnv('development'), true);
    assert.equal(provider.supportsEnv('local'), true);
    assert.equal(provider.supportsEnv('feature/x'), true);
    assert.equal(provider.supportsEnv('beta'), false);
    assert.equal(provider.supportsEnv('staging'), false);
    assert.equal(provider.supportsEnv('production'), false);
  });
});

