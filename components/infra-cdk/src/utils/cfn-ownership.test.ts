import { describe, expect, it } from '@jest/globals';
import { owningStackName, type AwsCliRunner } from './cfn-ownership';

const fail = (stderr: string): AwsCliRunner => async () => {
  throw Object.assign(new Error('Command failed'), { stderr });
};

describe('owningStackName', () => {
  it('returns the owning stack name', async () => {
    const run: AwsCliRunner = async () => JSON.stringify('Stagingweb-angularStaticSite');
    await expect(owningStackName('E3P52JIA2I4XO6', 'us-east-1', run)).resolves.toBe('Stagingweb-angularStaticSite');
  });

  it('returns null when no stack owns the resource', async () => {
    const run = fail('An error occurred (ValidationError): Stack for E123 does not exist');
    await expect(owningStackName('E123', 'us-east-1', run)).resolves.toBeNull();
  });

  it('returns undefined when ownership cannot be determined', async () => {
    await expect(owningStackName('E123', 'us-east-1', fail('AccessDenied'))).resolves.toBeUndefined();
  });
});

