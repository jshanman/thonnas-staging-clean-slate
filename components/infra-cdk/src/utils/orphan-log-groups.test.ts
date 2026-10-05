import { describe, expect, it } from '@jest/globals';
import { findOrphanServiceLogGroups, orphanLogGroupContext, type AwsCliRunner } from './orphan-log-groups';

const cliError = (stderr: string) => Object.assign(new Error('Command failed'), { stderr });

const runner = (groups: string[], owned: Record<string, 'owned' | 'orphan' | 'denied'>): AwsCliRunner =>
  async (args) => {
    if (args[0] === 'logs') return JSON.stringify(groups);
    const name = args[args.indexOf('--physical-resource-id') + 1];
    const state = owned[name];
    if (state === 'owned') return JSON.stringify('SomeStack');
    if (state === 'orphan') throw cliError(`An error occurred (ValidationError): Stack for ${name} does not exist`);
    throw cliError('An error occurred (AccessDenied): not authorized');
  };

describe('findOrphanServiceLogGroups', () => {
  it('returns only log groups with no owning stack', async () => {
    const run = runner(['/thonnas/Staging/api-go', '/thonnas/Staging/worker', '/thonnas/Staging/other'], {
      '/thonnas/Staging/api-go': 'owned',
      '/thonnas/Staging/worker': 'orphan',
      '/thonnas/Staging/other': 'denied',
    });
    await expect(findOrphanServiceLogGroups('us-east-1', run)).resolves.toEqual(['/thonnas/Staging/worker']);
  });

  it('returns nothing when log groups cannot be listed', async () => {
    const run: AwsCliRunner = async () => {
      throw cliError('An error occurred (AccessDenied)');
    };
    await expect(findOrphanServiceLogGroups('us-east-1', run)).resolves.toEqual([]);
  });

  it('maps orphans to CDK context keys', () => {
    expect(orphanLogGroupContext(['/thonnas/Staging/worker'])).toEqual({
      'ThonnasLogGroupOrphan:/thonnas/Staging/worker': 'true',
    });
  });
});

