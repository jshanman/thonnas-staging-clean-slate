import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { waitUntilServicesStable } from '@aws-sdk/client-ecs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isPauseContainerImage,
  isPrimaryGenerationReady,
  loadResolvedAppSecretEnv,
  loadResolvedHostEnv,
  mergeHostEnvIntoContainer,
  readSecretExportNames,
  releaseEcsFargate,
  releaseTargetGroupName,
  resolveEcsReleaseIds,
  resolveReleaseImage,
  rollbackEcsFargate,
  withReleaseContainerHealth,
  wiringClusterName,
} from './ecs-fargate';
import { ecrImageUri, ecrRepositoryName } from '../utils/path-helpers';

const mockSend = jest.fn();
const mockElbSend = jest.fn();
const mockWait = waitUntilServicesStable as unknown as {
  mockReset: () => void;
  mockImplementation: (fn: (...args: unknown[]) => Promise<unknown>) => void;
};

jest.mock('@aws-sdk/client-ecs', () => {
  const actual = jest.requireActual('@aws-sdk/client-ecs') as typeof import('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    waitUntilServicesStable: jest.fn(async () => ({ state: 'SUCCESS' })),
  };
});

jest.mock('@aws-sdk/client-elastic-load-balancing-v2', () => {
  const actual = jest.requireActual(
    '@aws-sdk/client-elastic-load-balancing-v2',
  ) as typeof import('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: jest.fn().mockImplementation(() => ({ send: mockElbSend })),
  };
});

jest.mock('@aws-sdk/client-sts', () => {
  const actual = jest.requireActual('@aws-sdk/client-sts') as typeof import('@aws-sdk/client-sts');
  return {
    ...actual,
    STSClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(async () => {
        throw new Error('sts unavailable in unit test');
      }),
    })),
  };
});

const ctxBase = {
  projectRoot: '/',
  env: 'staging',
  component: 'fixture-api',
  strategyKey: 'infra.container.managed-host',
  extras: { projectName: 'live-feat001' },
  imageTag: 'phase6-a',
};

const TEST_ACCOUNT = '123456789012';
const TEST_REGION = 'us-east-1';

function mockReleaseFlow(options?: {
  image?: string;
  port?: number;
  loadBalancers?: Array<{ targetGroupArn: string }>;
  runningCount?: number;
}): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    if (name === 'DescribeServicesCommand') {
      return {
        services: [
          {
            taskDefinition: 'arn:td:1',
            runningCount: options?.runningCount ?? 2,
            loadBalancers: options?.loadBalancers,
          },
        ],
      };
    }
    if (name === 'DescribeTaskDefinitionCommand') {
      return {
        taskDefinition: {
          family: 'staging-fixture-api',
          containerDefinitions: [
            {
              name: 'fixture-api',
              image: options?.image ?? 'public.ecr.aws/pause:3.9',
              portMappings: [{ containerPort: options?.port ?? 3000 }],
            },
          ],
          requiresCompatibilities: ['FARGATE'],
          cpu: '256',
          memory: '512',
          networkMode: 'awsvpc',
        },
      };
    }
    if (name === 'RegisterTaskDefinitionCommand') {
      return { taskDefinition: { taskDefinitionArn: 'arn:td:2' } };
    }
    if (name === 'UpdateServiceCommand') {
      return {};
    }
    throw new Error(`unexpected ${name}`);
  });
}

describe('ecs-fargate release ids', () => {
  it('uses extras.cluster/service when present', () => {
    expect(
      resolveEcsReleaseIds({
        projectRoot: '/',
        env: 'staging',
        component: 'fixture-api',
        extras: { cluster: 'prod-cluster', service: 'api' },
        imageTag: 'sha-1',
      }),
    ).toEqual({ cluster: 'prod-cluster', service: 'api', imageTag: 'sha-1' });
  });

  it('defaults cluster to Wiring-shaped name, not env-cluster', () => {
    const ids = resolveEcsReleaseIds({
      projectRoot: '/',
      env: 'staging',
      component: 'fixture-api',
      extras: { projectName: 'live-feat001' },
    });
    expect(ids.cluster).toBe(wiringClusterName('staging', 'live-feat001'));
    expect(ids.cluster).toBe('LiveFeat001StagingWiring-cluster');
    expect(ids.cluster).not.toBe('staging-cluster');
    expect(ids.service).toBe('staging-fixture-api');
  });

  it('slices dashboard TG names to 32 chars', () => {
    expect(
      releaseTargetGroupName(
        {
          projectRoot: '/',
          env: 'staging',
          component: 'fixture-dashboard',
          strategyKey: 'infra.observe.dashboard',
        },
        'staging-fixture-dashboard-dashboard',
      ),
    ).toBe('ip-staging-fixture-dashboard-das');
    expect(isPauseContainerImage('public.ecr.aws/eks-distro/kubernetes/pause:3.9')).toBe(true);
    expect(isPauseContainerImage('public.ecr.aws/nginx/nginx:1.27')).toBe(false);
    expect(
      withReleaseContainerHealth<{ image: string; healthCheck?: { command?: string[] } }>({
        image: 'public.ecr.aws/eks-distro/kubernetes/pause:3.9',
      }).healthCheck,
    ).toBeUndefined();
    expect(
      withReleaseContainerHealth<{ image: string; healthCheck?: { command?: string[] } }>({
        image: 'public.ecr.aws/nginx/nginx:1.27',
      }).healthCheck?.command,
    ).toEqual(['CMD-SHELL', 'exit 0']);
    expect(
      withReleaseContainerHealth<{ image: string; healthCheck?: { command?: string[] } }>({
        image: 'otel/opentelemetry-collector:0.114.0',
        healthCheck: { command: ['CMD-SHELL', 'exit 0'] },
      }).healthCheck,
    ).toBeUndefined();
    // Signoz product images are not special-cased in shared helper (fixture/package owns boot)
    expect(
      withReleaseContainerHealth<{ image: string; healthCheck?: { command?: string[] } }>({
        image: 'signoz/signoz-otel-collector:v0.144.9',
        healthCheck: { command: ['CMD-SHELL', 'exit 0'] },
      }).healthCheck?.command,
    ).toEqual(['CMD-SHELL', 'exit 0']);
  });

  it('resolves pause + bare tag to apply ECR URI and keeps full URI / non-pause tag-swap', () => {
    expect(ecrRepositoryName('staging', 'fixture-api')).toBe('staging-fixture-api');
    expect(ecrRepositoryName('staging', 'fixture-api', 'e2efe001')).toBe('e2efe001/staging-fixture-api');
    expect(ecrRepositoryName('staging', 'api-nest', 'E2e Feat-001')).toBe('e2efeat-001/staging-api-nest');
    expect(
      resolveReleaseImage('public.ecr.aws/eks-distro/kubernetes/pause:3.9', 'sha-abc', {
        env: 'staging',
        component: 'fixture-api',
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
      }),
    ).toEqual({
      image: ecrImageUri(TEST_ACCOUNT, TEST_REGION, 'staging-fixture-api', 'sha-abc'),
    });
    expect(
      resolveReleaseImage('public.ecr.aws/eks-distro/kubernetes/pause:3.9', 'sha-abc', {
        env: 'staging',
        component: 'fixture-api',
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
        projectName: 'e2efe001',
      }),
    ).toEqual({
      image: ecrImageUri(TEST_ACCOUNT, TEST_REGION, 'e2efe001/staging-fixture-api', 'sha-abc'),
    });
    expect(resolveReleaseImage('public.ecr.aws/eks-distro/kubernetes/pause:3.9', 'sha-abc')).toEqual({
      error: expect.stringMatching(/cannot leave the pause image/),
    });
    expect(
      resolveReleaseImage(
        'public.ecr.aws/eks-distro/kubernetes/pause:3.9',
        'public.ecr.aws/docker/library/nginx:1.27.4',
      ),
    ).toEqual({ image: 'public.ecr.aws/docker/library/nginx:1.27.4' });
    expect(resolveReleaseImage('123.dkr.ecr.us-east-1.amazonaws.com/staging-api:old', 'new-tag')).toEqual({
      image: '123.dkr.ecr.us-east-1.amazonaws.com/staging-api:new-tag',
    });
  });
});

describe('releaseEcsFargate', () => {
  const prevAccount = process.env.CDK_DEFAULT_ACCOUNT;
  const prevRegion = process.env.AWS_REGION;

  beforeEach(() => {
    mockSend.mockReset();
    mockWait.mockReset();
    mockWait.mockImplementation(async () => ({ state: 'SUCCESS' }));
    mockElbSend.mockReset();
    process.env.CDK_DEFAULT_ACCOUNT = TEST_ACCOUNT;
    process.env.AWS_REGION = TEST_REGION;
  });

  afterEach(() => {
    if (prevAccount === undefined) delete process.env.CDK_DEFAULT_ACCOUNT;
    else process.env.CDK_DEFAULT_ACCOUNT = prevAccount;
    if (prevRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prevRegion;
  });

  it('returns kind released with from/to task-def ARNs and waits stable', async () => {
    mockReleaseFlow({ loadBalancers: [{ targetGroupArn: 'arn:tg:existing' }] });
    const result = await releaseEcsFargate(ctxBase);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(result.binding).toBe('ecs-fargate');
    expect(result.from).toBe('arn:td:1');
    expect(result.to).toBe('arn:td:2');
    const update = mockSend.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateServiceCommand',
    );
    expect((update?.[0] as { input?: { taskDefinition?: string } }).input?.taskDefinition).toBe('arn:td:2');
    expect((update?.[0] as { input?: { loadBalancers?: unknown } }).input?.loadBalancers).toBeUndefined();
    expect(mockWait).toHaveBeenCalled();
    const register = mockSend.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'RegisterTaskDefinitionCommand',
    );
    const registeredImage = (
      register?.[0] as { input?: { containerDefinitions?: Array<{ image?: string }> } }
    ).input?.containerDefinitions?.[0]?.image;
    expect(registeredImage).toBe(
      ecrImageUri(
        TEST_ACCOUNT,
        TEST_REGION,
        ecrRepositoryName('staging', 'fixture-api', 'live-feat001'),
        'phase6-a',
      ),
    );
  });

  it('fails closed when pause + bare tag cannot resolve ECR account/component', async () => {
    delete process.env.CDK_DEFAULT_ACCOUNT;
    delete process.env.AWS_ACCOUNT_ID;
    delete process.env.THONNAS_AWS_ACCOUNT_ID;
    mockReleaseFlow();
    await expect(
      releaseEcsFargate({
        ...ctxBase,
        component: undefined,
        extras: { projectName: 'live-feat001', service: 'staging-fixture-api' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/cannot leave the pause image/),
    });
  });

  it('fails closed when --image-tag is latest or omitted', async () => {
    await expect(releaseEcsFargate({ ...ctxBase, imageTag: 'latest' })).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/pinned --image-tag/),
    });
    await expect(releaseEcsFargate({ ...ctxBase, imageTag: undefined })).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/pinned --image-tag/),
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('attaches the TG in the same UpdateService as a pinned good image', async () => {
    mockReleaseFlow({ image: 'public.ecr.aws/nginx/nginx:1.27', port: 3000 });
    mockElbSend.mockImplementation(async () => ({
      TargetGroups: [{ TargetGroupArn: 'arn:tg:fixture-api' }],
    }));
    const result = await releaseEcsFargate({ ...ctxBase, imageTag: 'sha-good' });
    expect(result.ok).toBe(true);
    const update = mockSend.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateServiceCommand',
    );
    expect((update?.[0] as { input?: { taskDefinition?: string; loadBalancers?: unknown } }).input).toEqual(
      expect.objectContaining({
        taskDefinition: 'arn:td:2',
        loadBalancers: [
          {
            targetGroupArn: 'arn:tg:fixture-api',
            containerName: 'fixture-api',
            containerPort: 3000,
          },
        ],
      }),
    );
    expect(mockElbSend).toHaveBeenCalled();
    expect(mockWait).toHaveBeenCalled();
    const register = mockSend.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'RegisterTaskDefinitionCommand',
    );
    const registeredContainers = (
      register?.[0] as {
        input?: { containerDefinitions?: Array<{ healthCheck?: { command?: string[] }; image?: string }> };
      }
    ).input?.containerDefinitions;
    expect(registeredContainers?.[0]?.healthCheck?.command).toEqual(['CMD-SHELL', 'exit 0']);
    expect(registeredContainers?.[0]?.image).toBe('public.ecr.aws/nginx/nginx:sha-good');
  });

  it('does not attach a collector release', async () => {
    mockReleaseFlow({ image: 'otel/opentelemetry-collector:0.115.1', port: 4317 });
    const result = await releaseEcsFargate({
      ...ctxBase,
      component: 'fixture-observe',
      strategyKey: 'infra.observe.metrics',
      extras: { projectName: 'live-feat001', service: 'staging-fixture-observe-collector' },
      imageTag: 'sha-otel',
    });
    expect(result.ok).toBe(true);
    const update = mockSend.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateServiceCommand',
    );
    expect((update?.[0] as { input?: { loadBalancers?: unknown } }).input?.loadBalancers).toBeUndefined();
    expect(mockElbSend).not.toHaveBeenCalled();
    const register = mockSend.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'RegisterTaskDefinitionCommand',
    );
    const registeredContainers = (
      register?.[0] as { input?: { containerDefinitions?: Array<{ healthCheck?: { command?: string[] } }> } }
    ).input?.containerDefinitions;
    expect(registeredContainers?.[0]?.healthCheck).toBeUndefined();
  });

  it('sizes services-stable from health.graceSeconds plus drain and ALB threshold', async () => {
    mockReleaseFlow({ loadBalancers: [{ targetGroupArn: 'arn:tg:existing' }] });
    await releaseEcsFargate({
      ...ctxBase,
      extras: { projectName: 'live-feat001', 'health.graceSeconds': 600 },
    });
    expect(mockWait).toHaveBeenCalledWith(expect.objectContaining({ maxWaitTime: 900 }), expect.anything());
  });

  it('succeeds when the waiter times out but PRIMARY already runs the new task def', async () => {
    mockWait.mockImplementation(async () => {
      throw new Error('Timeout');
    });
    let describes = 0;
    mockSend.mockImplementation(async (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === 'DescribeServicesCommand') {
        describes += 1;
        if (describes === 1) {
          return {
            services: [
              {
                taskDefinition: 'arn:td:1',
                runningCount: 2,
                loadBalancers: [{ targetGroupArn: 'arn:tg:existing' }],
              },
            ],
          };
        }
        return {
          services: [
            {
              taskDefinition: 'arn:td:2',
              runningCount: 2,
              deployments: [
                {
                  status: 'PRIMARY',
                  taskDefinition: 'arn:td:2',
                  rolloutState: 'IN_PROGRESS',
                  runningCount: 2,
                },
              ],
            },
          ],
        };
      }
      if (name === 'DescribeTaskDefinitionCommand') {
        return {
          taskDefinition: {
            family: 'staging-fixture-api',
            containerDefinitions: [
              {
                name: 'fixture-api',
                image: 'public.ecr.aws/nginx/nginx:1.27',
                portMappings: [{ containerPort: 3000 }],
              },
            ],
            requiresCompatibilities: ['FARGATE'],
            cpu: '256',
            memory: '512',
            networkMode: 'awsvpc',
          },
        };
      }
      if (name === 'RegisterTaskDefinitionCommand') {
        return { taskDefinition: { taskDefinitionArn: 'arn:td:2' } };
      }
      if (name === 'UpdateServiceCommand') {
        return {};
      }
      throw new Error(`unexpected ${name}`);
    });
    await expect(releaseEcsFargate(ctxBase)).resolves.toMatchObject({ ok: true, kind: 'released', to: 'arn:td:2' });
  });

  it('treats PRIMARY of the new generation with minHealthy tasks as ready', () => {
    expect(
      isPrimaryGenerationReady({
        expectedTaskDefinition: 'arn:td:2',
        minHealthy: 2,
        service: {
          deployments: [
            { status: 'PRIMARY', taskDefinition: 'arn:td:2', rolloutState: 'IN_PROGRESS', runningCount: 2 },
            { status: 'ACTIVE', taskDefinition: 'arn:td:1', runningCount: 2 },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isPrimaryGenerationReady({
        expectedTaskDefinition: 'arn:td:2',
        minHealthy: 2,
        service: {
          deployments: [{ status: 'PRIMARY', taskDefinition: 'arn:td:1', runningCount: 2 }],
        },
      }),
    ).toBe(false);
  });

  it('preserves apply-time columnar env and secrets on collector release without Signoz boot', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === 'DescribeServicesCommand') {
        return {
          services: [
            {
              taskDefinition: 'arn:td:1',
              runningCount: 1,
            },
          ],
        };
      }
      if (name === 'DescribeTaskDefinitionCommand') {
        return {
          taskDefinition: {
            family: 'staging-fixture-observe-collector',
            containerDefinitions: [
              {
                name: 'collector',
                image: 'public.ecr.aws/eks-distro/kubernetes/pause:3.9',
                portMappings: [{ containerPort: 4318 }],
                environment: [{ name: 'THONNAS_COLUMNAR_HOST', value: '10.0.1.20' }],
                secrets: [
                  {
                    name: 'THONNAS_COLUMNAR_PASSWORD',
                    valueFrom: 'arn:aws:secretsmanager:us-east-1:123:secret:col:password::',
                  },
                ],
              },
            ],
            requiresCompatibilities: ['FARGATE'],
            cpu: '256',
            memory: '512',
            networkMode: 'awsvpc',
          },
        };
      }
      if (name === 'RegisterTaskDefinitionCommand') {
        return { taskDefinition: { taskDefinitionArn: 'arn:td:2' } };
      }
      if (name === 'UpdateServiceCommand') {
        return {};
      }
      throw new Error(`unexpected ${name}`);
    });
    const result = await releaseEcsFargate({
      ...ctxBase,
      component: 'fixture-observe',
      strategyKey: 'infra.observe.metrics',
      extras: { projectName: 'live-feat001', service: 'staging-fixture-observe-collector' },
      imageTag: 'signoz/signoz-otel-collector:v0.144.9',
    });
    expect(result.ok).toBe(true);
    const register = mockSend.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'RegisterTaskDefinitionCommand',
    );
    const registered = (
      register?.[0] as {
        input?: {
          containerDefinitions?: Array<{
            environment?: Array<{ name?: string; value?: string }>;
            secrets?: Array<{ name?: string; valueFrom?: string }>;
            command?: string[];
            entryPoint?: string[];
            image?: string;
          }>;
        };
      }
    ).input?.containerDefinitions?.[0];
    expect(registered?.image).toBe('signoz/signoz-otel-collector:v0.144.9');
    expect(registered?.environment).toEqual(
      expect.arrayContaining([{ name: 'THONNAS_COLUMNAR_HOST', value: '10.0.1.20' }]),
    );
    expect(registered?.secrets).toEqual([
      {
        name: 'THONNAS_COLUMNAR_PASSWORD',
        valueFrom: 'arn:aws:secretsmanager:us-east-1:123:secret:col:password::',
      },
    ]);
    expect(registered?.command).toBeUndefined();
    expect(registered?.entryPoint).toBeUndefined();
  });

  it('releases dashboard image without Signoz boot command and accepts xs/dev runningCount 1', async () => {
    mockReleaseFlow({
      image: 'public.ecr.aws/eks-distro/kubernetes/pause:3.9',
      port: 8080,
      runningCount: 1,
    });
    mockElbSend.mockImplementation(async () => ({
      TargetGroups: [{ TargetGroupArn: 'arn:tg:p6dash' }],
    }));
    const result = await releaseEcsFargate({
      ...ctxBase,
      component: 'fixture-dashboard',
      strategyKey: 'infra.observe.dashboard',
      extras: {
        projectName: 'p6sig',
        service: 'staging-fixture-dashboard-dashboard',
        capacity: 'xs',
        reliability: 'dev',
      },
      imageTag: 'signoz/signoz:v0.140.0',
    });
    expect(result.ok).toBe(true);
    const register = mockSend.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'RegisterTaskDefinitionCommand',
    );
    const registered = (
      register?.[0] as {
        input?: {
          containerDefinitions?: Array<{
            entryPoint?: string[];
            command?: string[];
            mountPoints?: unknown;
            image?: string;
          }>;
        };
      }
    ).input?.containerDefinitions?.[0];
    expect(registered?.image).toBe('signoz/signoz:v0.140.0');
    expect(registered?.entryPoint).toBeUndefined();
    expect(registered?.command).toBeUndefined();
    expect(registered?.mountPoints).toBeUndefined();
  });

  it('does not define collectorSignozBoot or dashboardSignozBoot in shared release', async () => {
    const fsSync = await import('node:fs');
    const pathMod = await import('node:path');
    const src = fsSync.readFileSync(pathMod.join(__dirname, 'ecs-fargate.ts'), 'utf8');
    expect(src).not.toMatch(/collectorSignozBoot/);
    expect(src).not.toMatch(/dashboardSignozBoot/);
    expect(src).not.toMatch(/\/signoz migrate/);
    expect(src).not.toMatch(/SIGNOZ_/);
  });
});

describe('rollbackEcsFargate', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockWait.mockReset();
    mockWait.mockImplementation(async () => ({ state: 'SUCCESS' }));
  });

  it('fails closed when restoreGenerationId is omitted', async () => {
    const result = await rollbackEcsFargate(ctxBase);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('unknown');
    expect(result.message).toMatch(/restoreGenerationId/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends UpdateService for the restore task def and waits stable', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === 'DescribeServicesCommand') {
        return { services: [{ taskDefinition: 'arn:td:2', runningCount: 2 }] };
      }
      if (name === 'DescribeTaskDefinitionCommand') {
        return { taskDefinition: { taskDefinitionArn: 'arn:td:1' } };
      }
      if (name === 'UpdateServiceCommand') {
        return {};
      }
      throw new Error(`unexpected ${name}`);
    });
    const result = await rollbackEcsFargate({ ...ctxBase, restoreGenerationId: 'arn:td:1' });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('released');
    expect(result.from).toBe('arn:td:2');
    expect(result.to).toBe('arn:td:1');
    const update = mockSend.mock.calls.find(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name === 'UpdateServiceCommand',
    );
    expect((update?.[0] as { input?: { taskDefinition?: string } }).input?.taskDefinition).toBe('arn:td:1');
    expect(mockWait).toHaveBeenCalled();
  });

  it('loads resolved host env including SECRET__ keys and skips blanks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ecs-host-env-'));
    await fs.writeFile(
      path.join(dir, '.env.staging'),
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://staging-p7col-collector:4318\nSECRET__DB=nope\nPORT=\n',
      'utf8',
    );
    await expect(loadResolvedHostEnv(dir, 'staging')).resolves.toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://staging-p7col-collector:4318',
      SECRET__DB: 'nope',
    });
  });

  it('merges host env into container environment without dropping existing keys', () => {
    const merged = mergeHostEnvIntoContainer(
      { environment: [{ name: 'THONNAS_ENV', value: 'staging' }] },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://staging-p7col-collector:4318' },
    );
    expect(merged.environment).toEqual(
      expect.arrayContaining([
        { name: 'THONNAS_ENV', value: 'staging' },
        { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://staging-p7col-collector:4318' },
      ]),
    );
  });

  it('keeps SECRET__ keys when merging host env for Nest custom-environment-variables', () => {
    const merged = mergeHostEnvIntoContainer(
      { environment: [{ name: 'THONNAS_ENV', value: 'staging' }] },
      { SECRET__DBT_MONGO_USERNAME: 'thonnas', SECRET__DBT_MONGO_PASSWORD: 'secret' },
    );
    expect(merged.environment).toEqual(
      expect.arrayContaining([
        { name: 'SECRET__DBT_MONGO_USERNAME', value: 'thonnas' },
        { name: 'SECRET__DBT_MONGO_PASSWORD', value: 'secret' },
      ]),
    );
  });

  it('reads export and cloneTo names from thonnas-secrets.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ecs-secrets-manifest-'));
    await fs.writeFile(
      path.join(dir, 'thonnas-secrets.json'),
      JSON.stringify({
        exports: [
          { name: 'API_HOST_JWT_SECRET', cloneTo: ['JWT_SECRET'] },
          { name: 'API_HOST_COOKIE_SECRET', cloneTo: ['COOKIE_SECRET'] },
        ],
      }),
      'utf8',
    );
    await expect(readSecretExportNames(dir)).resolves.toEqual(
      expect.arrayContaining([
        'API_HOST_JWT_SECRET',
        'SECRET__API_HOST_JWT_SECRET',
        'JWT_SECRET',
        'API_HOST_COOKIE_SECRET',
        'COOKIE_SECRET',
      ]),
    );
  });

  it('fills only thonnas-secrets.json keys from resolved env', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ecs-app-secrets-'));
    await fs.writeFile(
      path.join(dir, 'thonnas-secrets.json'),
      JSON.stringify({
        exports: [{ name: 'API_HOST_JWT_SECRET', cloneTo: ['JWT_SECRET'] }],
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, '.env.staging'),
      [
        'INFRA_LOCALSTACK_ENDPOINT=http://infra-localstack:4566',
        'DATABASE_URL=postgres://postgres:postgres@dbt-postgres:5432/app',
        'JWT_SECRET=fixture-jwt',
        'SECRET__API_HOST_JWT_SECRET=fixture-jwt',
        'QUEUE_SNS_TOPIC_ARN=arn:aws:sns:us-east-1:1:topic',
        '',
      ].join('\n'),
      'utf8',
    );
    await expect(loadResolvedAppSecretEnv(dir, 'staging')).resolves.toEqual({
      JWT_SECRET: 'fixture-jwt',
      SECRET__API_HOST_JWT_SECRET: 'fixture-jwt',
    });
  });

  it('does not overwrite apply-time env or secret names when filling gaps', () => {
    const merged = mergeHostEnvIntoContainer(
      {
        environment: [
          { name: 'THONNAS_ENV', value: 'staging' },
          { name: 'QUEUE_SNS_TOPIC_ARN', value: 'arn:from-apply' },
        ],
        secrets: [{ name: 'THONNAS_RELATIONAL_PASSWORD' }],
      },
      {
        THONNAS_ENV: 'development',
        JWT_SECRET: 'fixture-jwt',
        THONNAS_RELATIONAL_PASSWORD: 'from-compose',
      },
      { preserveExisting: true },
    );
    expect(merged.environment).toEqual(
      expect.arrayContaining([
        { name: 'THONNAS_ENV', value: 'staging' },
        { name: 'QUEUE_SNS_TOPIC_ARN', value: 'arn:from-apply' },
        { name: 'JWT_SECRET', value: 'fixture-jwt' },
      ]),
    );
    expect(merged.environment).not.toEqual(
      expect.arrayContaining([{ name: 'THONNAS_RELATIONAL_PASSWORD', value: 'from-compose' }]),
    );
  });
});



