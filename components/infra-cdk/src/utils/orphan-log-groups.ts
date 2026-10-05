// @intent Detect CloudWatch log groups left behind by a destroyed stack so re-apply can adopt them
import { defaultAwsCliRunner, owningStackName, type AwsCliRunner } from './cfn-ownership';

export type { AwsCliRunner } from './cfn-ownership';

/** CDK context key; stacks import the named log group instead of creating it when this is 'true'. */
export const LOG_GROUP_ORPHAN_CONTEXT_PREFIX = 'ThonnasLogGroupOrphan:';

/** Every service log group from buildServiceLogGroupName lives under this prefix. */
export const SERVICE_LOG_GROUP_ROOT = '/thonnas/';

/**
 * @intent A log group is orphaned when it exists but no live CloudFormation stack owns it.
 * Service log groups use CDK's default RETAIN policy and a fixed name, so destroying a stack
 * leaves the group behind and the next create fails with "already exists".
 */
export async function findOrphanServiceLogGroups(
  region: string,
  run: AwsCliRunner = defaultAwsCliRunner,
): Promise<string[]> {
  let names: string[];
  try {
    const stdout = await run([
      'logs',
      'describe-log-groups',
      '--region',
      region,
      '--log-group-name-prefix',
      SERVICE_LOG_GROUP_ROOT,
      '--query',
      'logGroups[].logGroupName',
      '--output',
      'json',
    ]);
    const parsed = JSON.parse(stdout || '[]') as unknown;
    names = Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }

  const orphans: string[] = [];
  for (const name of names) {
    // @intent Only a definite "no owning stack" means orphaned; unknown leaves the group alone
    if ((await owningStackName(name, region, run)) === null) orphans.push(name);
  }
  return orphans;
}

/** Map orphaned log group names to CDK context entries. */
export function orphanLogGroupContext(orphans: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of orphans) map[`${LOG_GROUP_ORPHAN_CONTEXT_PREFIX}${name}`] = 'true';
  return map;
}

