import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  CfnService,
  ContainerImage,
  FargatePlatformVersion,
  FargateTaskDefinition,
  FargateService,
  LogDriver,
  OperatingSystemFamily,
  Protocol as EcsProtocol,
} from 'aws-cdk-lib/aws-ecs';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  ApplicationListener,
  ApplicationListenerRule,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { EcsSharedStack } from './ecs-shared-stack';
import { ResolvedCloudComponent } from '../types';
import { SecurityGroup, Port } from 'aws-cdk-lib/aws-ec2';
import { extraNumber as portableExtraNumber, resolvePortableExtras } from '../release/portable-extras';
import { buildServiceLogGroupName } from '../utils/path-helpers';
import { LOG_GROUP_ORPHAN_CONTEXT_PREFIX } from '../utils/orphan-log-groups';
import { addAlbHostnameAlias, resolveHostedZoneDomain } from '../utils/alb-dns';
import { rememberContainerName } from './container-names';
import { applyReleasedContainer, isReleasedContainerImage, type ReleasedContainer } from './released-container';

// @intent Let release pull private ECR tags without a one-off IAM attach
export function grantFargateExecutionRoleEcrPull(task: FargateTaskDefinition): void {
  task.obtainExecutionRole().addManagedPolicy(
    ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
  );
}

/** Public pause image so apply does not require a project build or ECR pull. */
export const FARGATE_PAUSE_IMAGE = 'public.ecr.aws/eks-distro/kubernetes/pause:3.9';

// @intent Give each component a unique ALB host-header rule priority
export function listenerRulePriority(component: string): number {
  let hash = 2166136261;
  for (let i = 0; i < component.length; i += 1) {
    hash ^= component.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 49000) + 10;
}

export const extraNumber = portableExtraNumber;

// @intent HTTP desiredCount uses resolved scaling.min; do not re-floor dev to 2
export function httpDesiredCount(component: ResolvedCloudComponent, env?: string): number {
  const resolved = resolvePortableExtras({ env: env ?? component.env, extras: component.metadata.extras });
  return extraNumber(resolved, 'scaling.min') ?? component.metadata.scaling?.min ?? 2;
}

// @intent Map logs.retentionDays onto CDK RetentionDays
export function logRetention(extras?: Record<string, unknown>): logs.RetentionDays {
  const days = extraNumber(extras, 'logs.retentionDays') ?? 30;
  if (days <= 1) return logs.RetentionDays.ONE_DAY;
  if (days <= 7) return logs.RetentionDays.ONE_WEEK;
  if (days <= 14) return logs.RetentionDays.TWO_WEEKS;
  if (days <= 30) return logs.RetentionDays.ONE_MONTH;
  if (days <= 90) return logs.RetentionDays.THREE_MONTHS;
  return logs.RetentionDays.ONE_YEAR;
}

// @intent Create the fixed-name service log group, or adopt it when a destroyed stack left it
// behind (RETAIN) -- plan/apply set ThonnasLogGroupOrphan:<name> after checking no stack owns it
export function serviceLogGroup(
  scope: Construct,
  id: string,
  logGroupName: string,
  extras?: Record<string, unknown>,
): logs.ILogGroup {
  if (scope.node.tryGetContext(`${LOG_GROUP_ORPHAN_CONTEXT_PREFIX}${logGroupName}`) === 'true') {
    return logs.LogGroup.fromLogGroupName(scope, id, logGroupName);
  }
  return new logs.LogGroup(scope, id, { retention: logRetention(extras), logGroupName });
}

// @intent Autoscale only when max is greater than min
export function maybeAutoscaleService(service: FargateService, extras?: Record<string, unknown>): void {
  const min = extraNumber(extras, 'scaling.min') ?? 1;
  const max = extraNumber(extras, 'scaling.max') ?? min;
  if (max <= min) return;
  const scaling = service.autoScaleTaskCount({ minCapacity: min, maxCapacity: max });
  const metric = extras?.['scaling.metric'];
  if (typeof metric === 'string' && metric.toLowerCase() === 'cpu') {
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 70 });
  }
}

// @intent Use 100/200 rolling + breaker per 2026-09-06 AWS
export function rollingDeployment(extras?: Record<string, unknown>): {
  minHealthyPercent: number;
  maxHealthyPercent: number;
  circuitBreaker: { enable: true; rollback: true };
} {
  return {
    minHealthyPercent: extraNumber(extras, 'deploy.rolling.minHealthyPercent') ?? 100,
    maxHealthyPercent: extraNumber(extras, 'deploy.rolling.maxHealthyPercent') ?? 200,
    circuitBreaker: { enable: true, rollback: true },
  };
}

// @intent Health grace defaults to 60s from portable extras
export function healthGraceSeconds(extras?: Record<string, unknown>): number {
  return extraNumber(extras, 'health.graceSeconds') ?? 60;
}

// @intent Drain defaults to 60s so invented prove fits 8 min
export function drainTimeoutSeconds(extras?: Record<string, unknown>): number {
  return extraNumber(extras, 'drain.timeoutSeconds') ?? 60;
}

// @intent ALB health path/interval from extras, not vendor names
export function albHealthSettings(extras?: Record<string, unknown>): { path: string; intervalSeconds: number } {
  const path = typeof extras?.['health.path'] === 'string' && extras['health.path'].trim()
    ? extras['health.path'].trim()
    : '/';
  return {
    path,
    intervalSeconds: extraNumber(extras, 'health.intervalSeconds') ?? 30,
  };
}

// @intent Prefix ip- and project so Fargate TGs do not collide across projects
export function httpTargetGroupName(
  envKey: string,
  component: string,
  projectKey?: string,
): string {
  const proj = (projectKey || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  const env = envKey.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  const comp = component.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const base = proj ? `ip-${proj}-${env}-${comp}` : `ip-${env}-${comp}`;
  return base.slice(0, 32);
}

// @intent Never emit empty LoadBalancers that would detach after release
export function omitEmptyLoadBalancers(service: FargateService): void {
  const cfn = service.node.defaultChild as CfnService;
  cfn.addPropertyDeletionOverride('LoadBalancers');
}

export function serviceSecurityGroupExportName(stackId: string): string {
  return `${stackId}-ServiceSg`;
}

export interface EcsServiceStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  networking: NetworkingStack;
  shared: EcsSharedStack;
  repositoryName: string;
  imageTag: string;
  eventsBus?: {
    topicName: string;
    queueNames: string[];
    dlqNames: string[];
    queues?: Array<{ consumerId: string; queueName: string }>;
  };
  /** Live released container so apply does not reset pause or drop edge/release env. */
  releasedContainer?: ReleasedContainer;
  /** Component's own thonnas-config.json "internal" values, resolved from its .env.{env} file. */
  internalEnv?: Record<string, string>;
}

// @intent Materialize ECS Fargate services from resolved cloud components
export class EcsServiceStack extends Stack {
  public readonly serviceSecurityGroup: SecurityGroup;
  public readonly serviceSecurityGroupExportName: string;
  public readonly taskDefinition: FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: EcsServiceStackProps) {
    super(scope, id, props);

    if (!props.shared.cluster) {
      throw new Error('ECS cluster unavailable for Fargate workload');
    }

    if (!props.shared.httpsListener) {
      throw new Error('ALB listener required for ECS workload routing');
    }

    const privateSubnets = props.networking.privateSubnetSelection;
    if (!privateSubnets?.subnets?.length) {
      throw new Error(
        `EcsServiceStack requires private subnets (NAT) for env "${props.profile.envKey}". ` +
          'Fargate must not use public subnets. Enable private subnets on NetworkingStack (staging/production).',
      );
    }

    const extras = resolvePortableExtras({
      env: props.profile.envKey,
      extras: props.component.metadata.extras,
    });
    const containerPort = props.component.metadata.ports?.[0] ?? 80;
    const exposed = props.component.metadata.exposed !== false;
    const hostname = props.component.metadata.hostname?.trim();
    const rolling = rollingDeployment(extras);
    const grace = healthGraceSeconds(extras);
    const albHealth = albHealthSettings(extras);

    // @intent Own ECR so pause→release push has a real repo (name = ecrRepositoryName formula)
    new Repository(this, 'Repository', {
      repositoryName: props.repositoryName,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 5 }],
    });

    this.taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${props.profile.envKey}-${props.component.component}`,
      cpu: extraNumber(extras, 'capacity.cpu') ?? 256,
      memoryLimitMiB: extraNumber(extras, 'capacity.memory') ?? 512,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });
    const taskDefinition = this.taskDefinition;
    grantFargateExecutionRoleEcrPull(taskDefinition);

    const eventsBus = props.eventsBus;
    if (eventsBus?.topicName) {
      const account = Stack.of(this).account;
      const region = Stack.of(this).region;
      taskDefinition.addToTaskRolePolicy(
        new PolicyStatement({
          actions: ['sns:Publish'],
          resources: [`arn:aws:sns:${region}:${account}:${eventsBus.topicName}`],
        }),
      );
      const queueNames = [...(eventsBus.queueNames ?? []), ...(eventsBus.dlqNames ?? [])].filter(Boolean);
      if (queueNames.length > 0) {
        taskDefinition.addToTaskRolePolicy(
          new PolicyStatement({
            actions: [
              'sqs:ReceiveMessage',
              'sqs:DeleteMessage',
              'sqs:GetQueueUrl',
              'sqs:GetQueueAttributes',
              'sqs:ChangeMessageVisibility',
              'sqs:ChangeMessageVisibilityBatch',
            ],
            resources: queueNames.map((name) => `arn:aws:sqs:${region}:${account}:${name}`),
          }),
        );
      }
    }

    const eventsEnv: Record<string, string> = {};
    if (eventsBus?.topicName) {
      const account = Stack.of(this).account;
      const region = Stack.of(this).region;
      eventsEnv.QUEUE_SNS_REGION = region;
      eventsEnv.QUEUE_SNS_ACCOUNT_ID = account;
      eventsEnv.QUEUE_SNS_TOPIC_ARN = `arn:aws:sns:${region}:${account}:${eventsBus.topicName}`;
      const queueUrlMap: Record<string, string> = {};
      for (const queue of eventsBus.queues ?? []) {
        queueUrlMap[queue.consumerId] = `https://sqs.${region}.amazonaws.com/${account}/${queue.queueName}`;
      }
      if (Object.keys(queueUrlMap).length > 0) {
        eventsEnv.QUEUE_SNS_QUEUE_URL_MAP = JSON.stringify(queueUrlMap);
      }
    }

    const logGroup = serviceLogGroup(
      this,
      'LogGroup',
      // @intent Include stackPrefix so multi-project staging does not collide
      buildServiceLogGroupName(props.profile.stackPrefix, props.component.component),
      extras,
    );

    // @intent Pause on first apply; keep a released image so service-only apply does not roll back the app
    const released = props.releasedContainer;
    const image =
      released && isReleasedContainerImage(released.image)
        ? ContainerImage.fromRegistry(released.image)
        : ContainerImage.fromRegistry(FARGATE_PAUSE_IMAGE);
    const container = taskDefinition.addContainer('AppContainer', {
      containerName: props.component.component,
      image,
      portMappings: [{ containerPort, protocol: EcsProtocol.TCP, name: 'http' }],
      logging: LogDriver.awsLogs({
        streamPrefix: props.component.component,
        logGroup,
      }),
      environment: {
        THONNAS_ENV: props.profile.envKey,
        ...eventsEnv,
        ...props.internalEnv,
      },
    });
    rememberContainerName(container, 'THONNAS_ENV');
    for (const name of Object.keys(eventsEnv)) rememberContainerName(container, name);
    for (const name of Object.keys(props.internalEnv ?? {})) rememberContainerName(container, name);
    applyReleasedContainer(this, container, taskDefinition, released);

    this.serviceSecurityGroup = new SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.networking.vpc,
      allowAllOutbound: true,
      securityGroupName: `${props.profile.envKey}-${props.component.component}-ecs-sg`,
    });
    // @intent Stable export so filtered apply does not drop the SG export edge stacks still import
    this.serviceSecurityGroupExportName = serviceSecurityGroupExportName(this.stackName);
    this.exportValue(this.serviceSecurityGroup.securityGroupId, {
      name: this.serviceSecurityGroupExportName,
    });

    if (props.shared.albSecurityGroup) {
      this.serviceSecurityGroup.addIngressRule(
        props.shared.albSecurityGroup,
        Port.tcp(containerPort),
        'Allow ALB traffic',
      );
    }

    const namespace = props.shared.cluster.defaultCloudMapNamespace;
    const service = new FargateService(this, 'Service', {
      cluster: props.shared.cluster,
      taskDefinition,
      desiredCount: extraNumber(extras, 'scaling.min') ?? httpDesiredCount(props.component, props.profile.envKey),
      serviceName: `${props.profile.envKey}-${props.component.component}`,
      assignPublicIp: false,
      securityGroups: [this.serviceSecurityGroup],
      vpcSubnets: privateSubnets,
      minHealthyPercent: rolling.minHealthyPercent,
      maxHealthyPercent: rolling.maxHealthyPercent,
      circuitBreaker: rolling.circuitBreaker,
      healthCheckGracePeriod: Duration.seconds(grace),
      platformVersion: FargatePlatformVersion.LATEST,
      // @intent Enable ECS Exec so a running container's own DNS resolution/connectivity can be
      // inspected directly (`aws ecs execute-command`) instead of inferring it from client-side
      // error strings -- CDK's FargateService wires the required task-role SSM permissions and
      // cluster exec configuration automatically when this is set.
      enableExecuteCommand: true,
      ...(namespace
        ? {
            serviceConnectConfiguration: {
              namespace: namespace.namespaceName,
              services: [{ portMappingName: 'http', discoveryName: props.component.component, port: containerPort }],
            },
          }
        : {}),
    });
    omitEmptyLoadBalancers(service);
    maybeAutoscaleService(service, extras);

    if (!exposed) {
      return;
    }

    // @intent Leave the TG empty on apply; pause must never sit on the edge
    const targetGroup = new ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: httpTargetGroupName(
        props.profile.envKey,
        props.component.component,
        props.profile.projectKey,
      ),
      port: containerPort,
      protocol: ApplicationProtocol.HTTP,
      vpc: props.networking.vpc,
      targetType: TargetType.IP,
      healthCheck: {
        path: albHealth.path,
        healthyHttpCodes: '200-399',
        interval: Duration.seconds(albHealth.intervalSeconds),
      },
    });
    targetGroup.setAttribute('deregistration_delay.timeout_seconds', String(drainTimeoutSeconds(extras)));

    new ApplicationListenerRule(this, 'ListenerRule', {
      listener: props.shared.httpsListener as ApplicationListener,
      action: ListenerAction.forward([targetGroup]),
      priority: listenerRulePriority(props.component.component),
      conditions: hostname
        ? [ListenerCondition.hostHeaders([hostname])]
        : [ListenerCondition.pathPatterns(['/*'])],
    });

    // @intent Publish DNS for the host-header so the ALB is reachable by name
    const zoneDomain = resolveHostedZoneDomain(
      props.component.metadata.extras as Record<string, unknown> | undefined,
      props.shared.rootDomain,
    );
    if (hostname && zoneDomain && props.shared.loadBalancer) {
      addAlbHostnameAlias(this, 'AlbHostname', {
        hostname,
        hostedZoneDomain: zoneDomain,
        loadBalancer: props.shared.loadBalancer,
      });
    }
  }
}



