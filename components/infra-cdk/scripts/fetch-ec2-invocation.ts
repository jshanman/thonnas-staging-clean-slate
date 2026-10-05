#!/usr/bin/env tsx
/**
 * Fetch SSM command invocation result and write to components/infra-cdk/generated/ec2-invocation.json.
 * Use after aws ssm send-command; pass the returned CommandId and InstanceId.
 *
 * @intent Write SSM get-command-invocation output to infra-cdk/generated so it is not at project root.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { SSMClient, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';

// When run via npm script from component root, cwd is components/infra-cdk. Respect THONNAS_REPO_ROOT when set (e.g. run from project root).
function resolveGeneratedDir(): string {
  const repoRoot = process.env.THONNAS_REPO_ROOT ?? process.env.THONNAS_ROOT;
  if (repoRoot?.trim()) {
    return path.join(path.resolve(repoRoot.trim()), 'components', 'infra-cdk', 'generated');
  }
  return path.join(process.cwd(), 'generated');
}
const generatedDir = resolveGeneratedDir();
const outputPath = path.join(generatedDir, 'ec2-invocation.json');

function parseArgs(): { commandId: string; instanceId: string; region: string } {
  const args = process.argv.slice(2);
  let commandId = '';
  let instanceId = '';
  let region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--command-id' && args[i + 1]) {
      commandId = args[++i];
    } else if (args[i] === '--instance-id' && args[i + 1]) {
      instanceId = args[++i];
    } else if (args[i] === '--region' && args[i + 1]) {
      region = args[++i];
    }
  }

  if (!commandId || !instanceId) {
    console.error(
      'Usage: tsx scripts/fetch-ec2-invocation.ts --command-id COMMAND_ID --instance-id INSTANCE_ID [--region REGION]',
    );
    console.error('  Run aws ssm send-command first; use the returned CommandId and InstanceId.');
    process.exit(1);
  }
  if (!region) {
    console.error('Set AWS_REGION or pass --region.');
    process.exit(1);
  }

  return { commandId, instanceId, region };
}

async function main(): Promise<void> {
  const { commandId, instanceId, region } = parseArgs();

  const client = new SSMClient({ region });
  const response = await client.send(
    new GetCommandInvocationCommand({
      CommandId: commandId,
      InstanceId: instanceId,
    }),
  );

  await fs.mkdir(generatedDir, { recursive: true });
  const payload = {
    CommandId: response.CommandId,
    InstanceId: response.InstanceId,
    Comment: response.Comment,
    DocumentName: response.DocumentName,
    DocumentVersion: response.DocumentVersion,
    PluginName: response.PluginName,
    ResponseCode: response.ResponseCode,
    ExecutionStartDateTime: response.ExecutionStartDateTime,
    ExecutionElapsedTime: response.ExecutionElapsedTime,
    ExecutionEndDateTime: response.ExecutionEndDateTime,
    Status: response.Status,
    StatusDetails: response.StatusDetails,
    StandardOutputContent: response.StandardOutputContent,
    StandardOutputUrl: response.StandardOutputUrl,
    StandardErrorContent: response.StandardErrorContent,
    StandardErrorUrl: response.StandardErrorUrl,
    CloudWatchOutputConfig: response.CloudWatchOutputConfig,
  };
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});



