// @intent Ask CloudFormation which stack (if any) owns a physical resource
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AwsCliRunner = (args: string[]) => Promise<string>;

export const defaultAwsCliRunner: AwsCliRunner = async (args) => {
  const { stdout } = await execFileAsync('aws', args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

const errorText = (err: unknown): string => {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown };
    return `${String(e.stderr ?? '')} ${String(e.message ?? '')}`;
  }
  return String(err);
};

/**
 * @intent Owning stack name, null when no live stack owns it, undefined when ownership is unknown.
 * Callers must treat undefined as "owned": importing a stack-owned resource drops it from its
 * template and CloudFormation deletes it.
 */
export async function owningStackName(
  physicalResourceId: string,
  region: string,
  run: AwsCliRunner = defaultAwsCliRunner,
): Promise<string | null | undefined> {
  try {
    const stdout = await run([
      'cloudformation',
      'describe-stack-resources',
      '--region',
      region,
      '--physical-resource-id',
      physicalResourceId,
      '--query',
      'StackResources[0].StackName',
      '--output',
      'json',
    ]);
    const parsed = JSON.parse(stdout || 'null') as unknown;
    return typeof parsed === 'string' && parsed ? parsed : undefined;
  } catch (err) {
    return /does not exist/i.test(errorText(err)) ? null : undefined;
  }
}

