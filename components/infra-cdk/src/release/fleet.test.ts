import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fleetStackName, fleetStackSuffix, releaseFleet, rollbackFleet } from './fleet';
import type { ReleaseContext } from './context';

const mockCfnSend = jest.fn();
const mockEc2Send = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-cloudformation', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudformation') as typeof import('@aws-sdk/client-cloudformation');
  return { ...actual, CloudFormationClient: jest.fn().mockImplementation(() => ({ send: mockCfnSend })) };
});

jest.mock('@aws-sdk/client-ec2', () => {
  const actual = jest.requireActual('@aws-sdk/client-ec2') as typeof import('@aws-sdk/client-ec2');
  return { ...actual, EC2Client: jest.fn().mockImplementation(() => ({ send: mockEc2Send })) };
});

jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm') as typeof import('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })) };
});

function commandName(cmd: unknown): string {
  return (cmd as { constructor: { name: string } }).constructor.name;
}

describe('fleetStackSuffix / fleetStackName', () => {
  it('derives the suffix from the strategy key\'s last segment, capitalized', () => {
    expect(fleetStackSuffix('infra.compute.fleet.mqtt')).toBe('Mqtt');
    expect(fleetStackSuffix('infra.compute.fleet.dba')).toBe('Dba');
  });

  it('builds the deterministic stack name matching cdk/runtime.ts\'s own construction', () => {
    const ctx: ReleaseContext = {
      projectRoot: '/',
      env: 'staging',
      component: 'queue-mqtt',
      strategyKey: 'infra.compute.fleet.mqtt',
    };
    // @intent `${profile.stackPrefix}${component}${suffix}Fleet` -- component is used verbatim
    // (not Pascal-cased), exactly matching `new MqttFleetStack(app, \`${profile.stackPrefix}${component.component}MqttFleet\`, ...)`.
    expect(fleetStackName(ctx)).toBe('Stagingqueue-mqttMqttFleet');
  });

  it('includes the project name in the stack prefix when extras.projectName is set', () => {
    const ctx: ReleaseContext = {
      projectRoot: '/',
      env: 'staging',
      component: 'dba-clickhouse',
      strategyKey: 'infra.compute.fleet.dba',
      extras: { projectName: 'live-feat001' },
    };
    expect(fleetStackName(ctx)).toContain('dba-clickhouseDbaFleet');
    // @intent toPascalCase strips hyphens when building the stack prefix -- "live-feat001" -> "LiveFeat001".
    expect(fleetStackName(ctx)).toMatch(/^LiveFeat001/i);
  });
});

describe('releaseFleet', () => {
  let packageDir: string;

  beforeEach(async () => {
    packageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-'));
    mockCfnSend.mockReset();
    mockEc2Send.mockReset();
    mockSsmSend.mockReset();
  });

  afterEach(async () => {
    await fs.rm(packageDir, { recursive: true, force: true });
  });

  const baseCtx = (overrides?: Partial<ReleaseContext>): ReleaseContext => ({
    projectRoot: '/',
    env: 'staging',
    component: 'queue-mqtt',
    strategyKey: 'infra.compute.fleet.mqtt',
    extras: { bootstrapScript: 'bootstrap-emqx.sh' },
    packageDir,
    ...overrides,
  });

  it('fails closed with an actionable error when extras.bootstrapScript is not declared', async () => {
    const result = await releaseFleet(baseCtx({ extras: {} }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/extras\.bootstrapScript/);
  });

  it('fails closed with an actionable error when the bootstrap script file is missing', async () => {
    const result = await releaseFleet(baseCtx());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/bootstrap script not found/);
  });

  it('falls back to the running instance count when the stack has no NodeCount output (dba-fleet shape)', async () => {
    await fs.mkdir(path.join(packageDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(packageDir, 'scripts', 'bootstrap-clickhouse.sh'), '#!/usr/bin/env bash\necho hi\n');

    mockCfnSend.mockImplementation(async (cmd: unknown) => {
      expect(commandName(cmd)).toBe('DescribeStacksCommand');
      return {
        Stacks: [
          {
            Outputs: [
              { OutputKey: 'DbaFleetSecretArn', OutputValue: 'arn:aws:secretsmanager:us-east-1:1:secret:dba' },
              { OutputKey: 'DbaFleetVolumePath', OutputValue: '/var/lib/dba-data' },
              // No DbaFleetNodeCount output at all.
            ],
          },
        ],
      };
    });
    mockEc2Send.mockImplementation(async (cmd: unknown) => {
      expect(commandName(cmd)).toBe('DescribeInstancesCommand');
      return {
        Reservations: [{ Instances: [{ InstanceId: 'i-1' }, { InstanceId: 'i-2' }] }],
      };
    });
    mockSsmSend.mockImplementation(async (cmd: unknown) => {
      const name = commandName(cmd);
      if (name === 'SendCommandCommand') return { Command: { CommandId: 'cmd-1' } };
      if (name === 'GetCommandInvocationCommand') return { Status: 'Success' };
      throw new Error(`unexpected SSM command ${name}`);
    });

    const result = await releaseFleet(
      baseCtx({
        component: 'dba-clickhouse',
        strategyKey: 'infra.compute.fleet.dba',
        extras: { bootstrapScript: 'bootstrap-clickhouse.sh' },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(result.message).toContain('2 instance(s)');
    // @intent SendCommandCommand called once per instance (2 instances -> 2 sends).
    const sendCommandCalls = mockSsmSend.mock.calls.filter(([cmd]) => commandName(cmd) === 'SendCommandCommand');
    expect(sendCommandCalls).toHaveLength(2);
  });

  it('aggregates per-instance SSM failures into an overall failed BindingResult', async () => {
    await fs.mkdir(path.join(packageDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(packageDir, 'scripts', 'bootstrap-emqx.sh'), '#!/usr/bin/env bash\necho hi\n');

    mockCfnSend.mockImplementation(async () => ({
      Stacks: [
        {
          Outputs: [
            { OutputKey: 'MqttFleetSecretArn', OutputValue: 'arn:aws:secretsmanager:us-east-1:1:secret:mqtt' },
            { OutputKey: 'MqttFleetVolumePath', OutputValue: '/var/lib/mqtt-data' },
            { OutputKey: 'MqttFleetNodeCount', OutputValue: '2' },
          ],
        },
      ],
    }));
    mockEc2Send.mockImplementation(async () => ({
      Reservations: [{ Instances: [{ InstanceId: 'i-1' }, { InstanceId: 'i-2' }] }],
    }));
    let sendCommandCalls = 0;
    mockSsmSend.mockImplementation(async (cmd: unknown) => {
      const name = commandName(cmd);
      if (name === 'SendCommandCommand') {
        sendCommandCalls += 1;
        return { Command: { CommandId: `cmd-${sendCommandCalls}` } };
      }
      if (name === 'GetCommandInvocationCommand') {
        // First instance succeeds, second fails.
        return sendCommandCalls <= 1
          ? { Status: 'Success' }
          : { Status: 'Failed', StandardErrorContent: 'bootstrap script exited 1' };
      }
      throw new Error(`unexpected SSM command ${name}`);
    });

    const result = await releaseFleet(baseCtx());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Failed');
    expect(result.message).toContain('bootstrap script exited 1');
  });

  it('fails closed when the stack has no running instances', async () => {
    await fs.mkdir(path.join(packageDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(packageDir, 'scripts', 'bootstrap-emqx.sh'), '#!/usr/bin/env bash\necho hi\n');

    mockCfnSend.mockImplementation(async () => ({
      Stacks: [{ Outputs: [{ OutputKey: 'MqttFleetSecretArn', OutputValue: 'arn:secret' }] }],
    }));
    mockEc2Send.mockImplementation(async () => ({ Reservations: [] }));

    const result = await releaseFleet(baseCtx());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no running instances/);
  });
});

describe('rollbackFleet', () => {
  it('is a no-op -- fleet bootstrap is idempotent, not reversible to a previous generation', async () => {
    const result = await rollbackFleet({
      projectRoot: '/',
      env: 'staging',
      component: 'queue-mqtt',
      strategyKey: 'infra.compute.fleet.mqtt',
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('noop');
  });
});

