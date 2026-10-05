// @intent Reject env name release so it cannot collide with thonnas release

export const RELEASE_ENV_FORBIDDEN_MESSAGE =
  'The environment name "release" is reserved for the artifact verb (thonnas release). Use --env staging for pre-prod.';

export function assertEnvNotNamedRelease(env: string): void {
  if (env === 'release') {
    throw new Error(RELEASE_ENV_FORBIDDEN_MESSAGE);
  }
}



