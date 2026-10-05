// @intent Detect whether the target account/region has already been CDK bootstrapped
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const BOOTSTRAP_PARAMETER = '/cdk-bootstrap/hnb659fds/version';
const bootstrapCache = new Map<string, boolean>();

export class BootstrapPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapPermissionError';
  }
}

const createSsmClient = (region: string): SSMClient => {
  return new SSMClient({ region });
};

export const isBootstrapped = async (accountId: string, region: string): Promise<boolean> => {
  const cacheKey = `${accountId}:${region}`;
  if (bootstrapCache.has(cacheKey)) {
    return bootstrapCache.get(cacheKey)!;
  }

  const client = createSsmClient(region);
  try {
    await client.send(
      new GetParameterCommand({
        Name: BOOTSTRAP_PARAMETER,
      }),
    );
    bootstrapCache.set(cacheKey, true);
    return true;
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : undefined;
    const message = error instanceof Error ? error.message : String(error);

    if (name === 'ParameterNotFound') {
      bootstrapCache.set(cacheKey, false);
      return false;
    }

    if (name === 'AccessDeniedException' || /AccessDenied/i.test(message)) {
      throw new BootstrapPermissionError(
        `Unable to read ${BOOTSTRAP_PARAMETER} in region ${region}. The AWS credentials must include the ssm:GetParameter permission.`,
      );
    }

    if (name === 'UnrecognizedClientException') {
      throw new BootstrapPermissionError(
        `AWS credentials were rejected while checking ${BOOTSTRAP_PARAMETER}. Verify that the access key is valid and has ssm:GetParameter.`,
      );
    }

    throw error;
  }
};

export const markBootstrapped = (accountId: string, region: string): void => {
  bootstrapCache.set(`${accountId}:${region}`, true);
};




