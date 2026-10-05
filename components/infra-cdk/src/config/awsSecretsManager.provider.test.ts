import { afterEach, describe, expect, it } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { candidateSecretIds } = require('./awsSecretsManager.provider.js') as {
  candidateSecretIds: (args: {
    componentKey: string;
    secretName: string;
    env: string;
  }) => string[];
};

describe('awsSecretsManager candidateSecretIds', () => {
  const prev = process.env.THONNAS_PROJECT_NAME;

  afterEach(() => {
    if (prev === undefined) delete process.env.THONNAS_PROJECT_NAME;
    else process.env.THONNAS_PROJECT_NAME = prev;
  });

  it('prefers full secret paths and project-prefixes bare names', () => {
    process.env.THONNAS_PROJECT_NAME = 'Demo Proj';
    expect(candidateSecretIds({ componentKey: 'dbt-mongo', secretName: 'docdb', env: 'staging' })).toEqual([
      'demoproj/staging/dbt-mongo/docdb',
      'staging/dbt-mongo/docdb',
      'dbt-mongo/staging/docdb',
    ]);
    expect(
      candidateSecretIds({
        componentKey: 'dbt-mongo',
        secretName: 'staging/dbt-mongo/docdb',
        env: 'staging',
      }),
    ).toEqual(['staging/dbt-mongo/docdb', 'demoproj/staging/dbt-mongo/docdb']);
  });
});



