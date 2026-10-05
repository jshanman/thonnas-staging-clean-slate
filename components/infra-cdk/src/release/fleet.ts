import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BindingResult } from './bindings';
import type { ReleaseContext } from './context';
import { buildEnvProfile } from '../cdk/env-profiles';

/**
 * Port of scripts/release-fleet.sh into an in-process release binding for `infra.compute.fleet.*`
 * strategies (dba-clickhouse's "store" slot, queue-mqtt's "broker" slot -- see load-target.ts's
 * byFleet matcher). `infra apply` only provisions the bare fleet EC2 instance(s); this is what
 * actually bootstraps/refreshes the real service (EMQX, ClickHouse, ...) on them, the same way
 * ECS release makes a Fargate service live. Idempotent per instance, safe to re-run.
 */

// @intent "infra.compute.fleet.mqtt" -> "Mqtt", "infra.compute.fleet.dba" -> "Dba" -- matches the
// exact suffix runtime.ts already uses to name the stack (`${stackPrefix}${component}${suffix}Fleet`).
export function fleetStackSuffix(strategyKey: string): string {
  const segment = strategyKey.split('.').pop() ?? '';
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

// @intent Deterministic stack name, no CloudFormation list-stacks lookup -- mirrors
// cdk/runtime.ts's own `new MqttFleetStack(app, \`${profile.stackPrefix}${component}MqttFleet\`, ...)`
// construction exactly, so release never has to guess/search for what apply already created.
export function fleetStackName(ctx: ReleaseContext): string {
  const extrasProject =
    typeof ctx.extras?.projectName === 'string' && ctx.extras.projectName.trim()
      ? ctx.extras.projectName.trim()
      : undefined;
  const profile = buildEnvProfile(ctx.env, [], undefined, extrasProject);
  const suffix = fleetStackSuffix(ctx.strategyKey ?? '');
  return `${profile.stackPrefix}${ctx.component}${suffix}Fleet`;
}

// @intent "MqttFleet" -> "MQTT_FLEET" so THONNAS_${prefix}_SECRET_ARN etc. match what each fleet
// stack's CfnOutput naming and each bootstrap script's env var contract already use verbatim --
// same derivation release-fleet.sh's ENV_PREFIX sed one-liner produces.
function buildEnvPrefix(suffix: string): string {
  return `${suffix.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_FLEET`;
}

interface FleetStackOutputs {
  secretArn: string;
  volumePath?: string;
  nodeCount?: number;
}

async function describeFleetStackOutputs(
  cfn: CloudFormationClient,
  stackName: string,
  suffix: string,
): Promise<FleetStackOutputs> {
  const result = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = result.Stacks?.[0]?.Outputs ?? [];
  const findOutput = (key: string): string | undefined => outputs.find((o) => o.OutputKey === key)?.OutputValue;

  const secretArn = findOutput(`${suffix}FleetSecretArn`);
  if (!secretArn) {
    throw new Error(`Fleet release could not resolve "${suffix}FleetSecretArn" output from stack "${stackName}".`);
  }
  const volumePath = findOutput(`${suffix}FleetVolumePath`);
  // @intent DbaFleetStack has no NodeCount output at all (only MqttFleetStack does) -- same
  // fallback release-fleet.sh already applies when the CFN output is absent.
  const nodeCountRaw = findOutput(`${suffix}FleetNodeCount`);
  return { secretArn, volumePath, nodeCount: nodeCountRaw ? Number(nodeCountRaw) : undefined };
}

async function describeRunningInstanceIds(ec2: EC2Client, stackName: string): Promise<string[]> {
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:aws:cloudformation:stack-name', Values: [stackName] },
        { Name: 'instance-state-name', Values: ['running'] },
      ],
    }),
  );
  const ids: string[] = [];
  for (const reservation of result.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      if (instance.InstanceId) ids.push(instance.InstanceId);
    }
  }
  return ids;
}

// @intent Build the remote shell command as a plain string -- the SDK's typed SendCommandCommand
// input carries it as a real array element, so (unlike the bash version) there's no need for the
// Python JSON-escaping workaround that existed purely to get a multi-line script safely through
// the `aws` CLI's own argument flattening.
function buildRemoteScript(options: {
  bootstrapScript: string;
  envPrefix: string;
  secretArn: string;
  volumePath: string;
  fleetId: string;
  nodeCount: number;
  env: string;
}): string {
  const { bootstrapScript, envPrefix, secretArn, volumePath, fleetId, nodeCount, env } = options;
  return (
    'set -euo pipefail\n' +
    `export THONNAS_${envPrefix}_SECRET_ARN=${secretArn}\n` +
    `export THONNAS_${envPrefix}_VOLUME_PATH=${volumePath}\n` +
    `export THONNAS_${envPrefix}_ID=${fleetId}\n` +
    `export THONNAS_${envPrefix}_EXPECTED_NODE_COUNT=${nodeCount}\n` +
    `export THONNAS_ENV=${env}\n` +
    "cat > /tmp/thonnas-fleet-bootstrap.sh << 'THONNAS_BOOTSTRAP_EOF'\n" +
    `${bootstrapScript}\n` +
    'THONNAS_BOOTSTRAP_EOF\n' +
    'chmod +x /tmp/thonnas-fleet-bootstrap.sh\n' +
    '/tmp/thonnas-fleet-bootstrap.sh\n'
  );
}

const TERMINAL_STATUSES = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut']);

async function pollCommandInvocation(
  ssm: SSMClient,
  commandId: string,
  instanceId: string,
  timeoutMs = 15 * 60 * 1000,
  pollIntervalMs = 10 * 1000,
): Promise<{ status: string; stderr?: string }> {
  const deadline = Date.now() + timeoutMs;
  let status = 'Pending';
  let stderr: string | undefined;
  while (Date.now() < deadline) {
    try {
      const result = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
      status = result.Status ?? 'Pending';
      stderr = result.StandardErrorContent;
    } catch {
      // Not yet registered on this instance -- keep polling until the timeout.
    }
    if (TERMINAL_STATUSES.has(status)) return { status, stderr };
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { status, stderr };
}

export async function releaseFleet(ctx: ReleaseContext): Promise<BindingResult> {
  if (!ctx.strategyKey) {
    return { ok: false, kind: 'unknown', binding: 'fleet', message: 'Fleet release requires a resolved strategyKey.' };
  }
  if (!ctx.component || !ctx.packageDir) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'fleet',
      message: 'Fleet release requires --target-component and a resolved packageDir.',
    };
  }
  const bootstrapScriptName =
    typeof ctx.extras?.bootstrapScript === 'string' && ctx.extras.bootstrapScript.trim()
      ? ctx.extras.bootstrapScript.trim()
      : undefined;
  if (!bootstrapScriptName) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'fleet',
      message:
        `Fleet release for "${ctx.component}" requires extras.bootstrapScript in thonnas-infra.json ` +
        '(e.g. "bootstrap-emqx.sh") -- no declarative source for the bootstrap script filename exists otherwise.',
    };
  }
  const bootstrapPath = path.join(ctx.packageDir, 'scripts', bootstrapScriptName);
  if (!existsSync(bootstrapPath)) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'fleet',
      message: `Fleet release bootstrap script not found at "${bootstrapPath}" (expected "thonnas install" to have copied it there).`,
    };
  }
  const bootstrapScriptContent = await fs.readFile(bootstrapPath, 'utf8');

  const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
  const stackName = fleetStackName(ctx);
  const suffix = fleetStackSuffix(ctx.strategyKey);
  const envPrefix = buildEnvPrefix(suffix);

  const cfn = new CloudFormationClient({ region });
  const ec2 = new EC2Client({ region });
  const ssm = new SSMClient({ region });

  const { secretArn, volumePath, nodeCount: outputNodeCount } = await describeFleetStackOutputs(cfn, stackName, suffix);
  const instanceIds = await describeRunningInstanceIds(ec2, stackName);
  if (instanceIds.length === 0) {
    return {
      ok: false,
      kind: 'unknown',
      binding: 'fleet',
      message: `Fleet release found no running instances for stack "${stackName}".`,
    };
  }
  const nodeCount = outputNodeCount ?? instanceIds.length;
  const resolvedVolumePath = volumePath ?? `/var/lib/${ctx.component}`;
  const remoteScript = buildRemoteScript({
    bootstrapScript: bootstrapScriptContent,
    envPrefix,
    secretArn,
    volumePath: resolvedVolumePath,
    fleetId: stackName,
    nodeCount,
    env: ctx.env,
  });

  let allSucceeded = true;
  const perInstanceMessages: string[] = [];
  for (const instanceId of instanceIds) {
    const sendResult = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Comment: `thonnas release fleet (${ctx.component}/${ctx.env}/${instanceId})`,
        TimeoutSeconds: 900,
        Parameters: { commands: [remoteScript] },
      }),
    );
    const commandId = sendResult.Command?.CommandId;
    if (!commandId) {
      allSucceeded = false;
      perInstanceMessages.push(`${instanceId}: failed to dispatch SSM command`);
      continue;
    }
    const invocation = await pollCommandInvocation(ssm, commandId, instanceId);
    if (invocation.status !== 'Success') {
      allSucceeded = false;
      const detail = invocation.stderr ? ` -- ${invocation.stderr.slice(0, 500)}` : '';
      perInstanceMessages.push(`${instanceId}: ${invocation.status}${detail}`);
    } else {
      perInstanceMessages.push(`${instanceId}: Success`);
    }
  }

  return {
    ok: allSucceeded,
    kind: allSucceeded ? 'released' : 'unknown',
    binding: 'fleet',
    from: null,
    to: stackName,
    message: allSucceeded
      ? `Fleet bootstrap released on ${instanceIds.length} instance(s) for stack "${stackName}": ${perInstanceMessages.join('; ')}`
      : `Fleet bootstrap failed for stack "${stackName}": ${perInstanceMessages.join('; ')}`,
  };
}

// @intent Fleet bootstrap is idempotent/safe-to-rerun, not reversible to a "previous" state --
// there is no previous-generation concept for a fleet instance, same no-op shape bindings.ts
// already uses for compose-host rollback.
export async function rollbackFleet(ctx: ReleaseContext): Promise<BindingResult> {
  return {
    ok: true,
    kind: 'noop',
    binding: 'fleet',
    from: null,
    to: 'noop',
    message: `Fleet bootstrap for "${ctx.component}" is idempotent, not reversible to a previous generation; rollback is a no-op by design.`,
  };
}

