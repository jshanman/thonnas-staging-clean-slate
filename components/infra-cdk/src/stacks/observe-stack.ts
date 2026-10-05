import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  ContainerImage,
  FargatePlatformVersion,
  FargateTaskDefinition,
  FargateService,
  LogDriver,
  OperatingSystemFamily,
  Protocol as EcsProtocol,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationListener,
  ApplicationListenerRule,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { EcsSharedStack } from './ecs-shared-stack';
import { ResolvedCloudComponent } from '../types';
import {
  FARGATE_PAUSE_IMAGE,
  albHealthSettings,
  drainTimeoutSeconds,
  extraNumber,
  grantFargateExecutionRoleEcrPull,
  healthGraceSeconds,
  httpDesiredCount,
  listenerRulePriority,
  serviceLogGroup,
  maybeAutoscaleService,
  omitEmptyLoadBalancers,
  rollingDeployment,
} from './ecs-service-stack';
import { hasOriginalScalingMin, resolvePortableExtras } from '../release/portable-extras';
import { buildServiceLogGroupName } from '../utils/path-helpers';
import { addAlbHostnameAlias, resolveHostedZoneDomain } from '../utils/alb-dns';

/**
 * Apply placeholder for the collector family (same pause image as managed-host).
 * Release image comes from the package / fixture hook — not a provider vendor pin.
 */
export const OBSERVE_COLLECTOR_IMAGE = FARGATE_PAUSE_IMAGE;
/**
 * Apply placeholder for the dashboard family (same pause image as managed-host).
 * Release image comes from the package / fixture hook — not a provider vendor pin.
 */
export const OBSERVE_DASHBOARD_IMAGE = FARGATE_PAUSE_IMAGE;

export interface ObserveStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  networking: NetworkingStack;
  shared: EcsSharedStack;
  /** When omitted, emit both families (legacy combined / strategy: observe). */
  emitCollector?: boolean;
  emitDashboard?: boolean;
  /** Same ecrRepositoryName formula as EcsServiceStack -- one repo per component, shared by
   * whichever family (collector/dashboard) this stack emits. */
  repositoryName?: string;
}

// @intent Name collector family/service {env}-{component}-collector
export function observeCollectorName(envKey: string, component: string): string {
  return `${envKey}-${component}-collector`;
}

// @intent Name dashboard family/service {env}-{component}-dashboard
export function observeDashboardName(envKey: string, component: string): string {
  return `${envKey}-${component}-dashboard`;
}

// @intent Prefix ip- + project so dashboard TGs do not collide across projects
export function observeDashboardTargetGroupName(
  envKey: string,
  component: string,
  projectKey?: string,
): string {
  const proj = (projectKey || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  const name = observeDashboardName(envKey, component);
  const base = proj ? `ip-${proj}-${name}` : `ip-${name}`;
  return base.slice(0, 32);
}

// @intent Portable collector endpoint for apps (service name, not workshop hosts)
export function observeCollectorEndpoint(envKey: string, component: string): string {
  return `http://${observeCollectorName(envKey, component)}:4318`;
}

// @intent Emit collector/dashboard from strategyKey + slot aliases (collector|metrics)
export function observeFamiliesFromSlots(components: ResolvedCloudComponent[]): {
  collector: boolean;
  dashboard: boolean;
} {
  let collector = false;
  let dashboard = false;
  for (const item of components) {
    const slot = (item.strategy ?? '').toLowerCase();
    const key =
      typeof item.metadata.extras?.strategyKey === 'string' ? item.metadata.extras.strategyKey : '';
    if (key === 'infra.observe.metrics' || slot === 'metrics' || slot === 'collector') {
      collector = true;
    } else if (key === 'infra.observe.dashboard' || slot === 'dashboard') {
      dashboard = true;
    } else if (key.startsWith('infra.observe.') || slot === 'observe' || (!key && !slot)) {
      // @intent Legacy combined observe package emits both families
      collector = true;
      dashboard = true;
    }
  }
  if (!collector && !dashboard) {
    collector = true;
    dashboard = true;
  }
  return { collector, dashboard };
}

// @intent Materialize collector and/or pause dashboard as a self-contained observe node
export class ObserveStack extends Stack {
  public readonly collectorSecurityGroup?: SecurityGroup;
  public readonly dashboardSecurityGroup?: SecurityGroup;
  public readonly collectorEndpoint?: string;
  /** Exposed so ObserveToEcs can attach Service Connect publish on the edge. */
  public readonly collectorService?: FargateService;
  /** Exposed so DbaFleetToObserve can inject portable fleet env on the edge. */
  public readonly collectorTaskDefinition?: FargateTaskDefinition;
  public readonly dashboardTaskDefinition?: FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: ObserveStackProps) {
    super(scope, id, props);

    if (!props.shared.cluster) {
      throw new Error('Observe requires an ECS cluster.');
    }

    const privateSubnets = props.networking.privateSubnetSelection;
    if (!privateSubnets?.subnets?.length) {
      throw new Error(
        `ObserveStack requires private subnets (NAT) for env "${props.profile.envKey}". ` +
          'Fargate must not use public subnets. Enable private subnets on NetworkingStack (staging/production).',
      );
    }

    // @intent Own ECR so pause→release push has a real repo, same component-agnostic pattern
    // EcsServiceStack already uses (repositoryName = ecrRepositoryName formula) -- without this,
    // `thonnas release` has nowhere real to push a built collector/dashboard image. Create once
    // regardless of which family(ies) this stack emits; both share the same component-keyed repo.
    if (props.repositoryName) {
      new Repository(this, 'Repository', {
        repositoryName: props.repositoryName,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [{ maxImageCount: 5 }],
      });
    }

    const emitCollector = props.emitCollector !== false;
    const emitDashboard = props.emitDashboard !== false;
    const rawExtras = props.component.metadata.extras;
    const originalCollectorMin = hasOriginalScalingMin(rawExtras);
    const extras = resolvePortableExtras({ env: props.profile.envKey, extras: rawExtras });
    const rolling = rollingDeployment(extras);
    const grace = healthGraceSeconds(extras);
    const albHealth = albHealthSettings(extras);
    const envKey = props.profile.envKey;
    const componentKey = props.component.component;
    const collectorName = observeCollectorName(envKey, componentKey);
    const dashboardName = observeDashboardName(envKey, componentKey);
    const hostname = props.component.metadata.hostname?.trim();
    const dashboardPort = props.component.metadata.ports?.[0] ?? 8080;

    if (emitCollector) {
      const collectorTask = new FargateTaskDefinition(this, 'CollectorTask', {
        family: collectorName,
        cpu: extraNumber(extras, 'capacity.cpu') ?? 256,
        memoryLimitMiB: extraNumber(extras, 'capacity.memory') ?? 512,
        runtimePlatform: {
          operatingSystemFamily: OperatingSystemFamily.LINUX,
        },
      });
      grantFargateExecutionRoleEcrPull(collectorTask);

      const collectorLogs = serviceLogGroup(
        this,
        'CollectorLogGroup',
        // @intent Include stackPrefix so multi-project staging does not collide
        buildServiceLogGroupName(props.profile.stackPrefix, componentKey, 'collector'),
        extras,
      );

      collectorTask.addContainer('Collector', {
        containerName: 'collector',
        // @intent Apply uses pause; release publishes the package/fixture image
        image: ContainerImage.fromRegistry(OBSERVE_COLLECTOR_IMAGE),
        portMappings: [
          { containerPort: 4317, protocol: EcsProtocol.TCP, name: 'otlp-grpc' },
          { containerPort: 4318, protocol: EcsProtocol.TCP, name: 'otlp-http' },
        ],
        logging: LogDriver.awsLogs({
          streamPrefix: 'collector',
          logGroup: collectorLogs,
        }),
        // @intent Omit apply health; pause has no shell healthcheck
      });
      this.collectorTaskDefinition = collectorTask;
      this.collectorEndpoint = observeCollectorEndpoint(envKey, componentKey);

      this.collectorSecurityGroup = new SecurityGroup(this, 'CollectorSg', {
        vpc: props.networking.vpc,
        allowAllOutbound: true,
        securityGroupName: `${collectorName}-sg`,
      });
      // @intent Keep VPC CIDR ingress so the observe node is self-contained
      this.collectorSecurityGroup.addIngressRule(
        Peer.ipv4(props.networking.vpc.vpcCidrBlock),
        Port.tcp(4317),
        'OTLP gRPC from VPC CIDR',
      );
      this.collectorSecurityGroup.addIngressRule(
        Peer.ipv4(props.networking.vpc.vpcCidrBlock),
        Port.tcp(4318),
        'OTLP HTTP from VPC CIDR',
      );

      // @intent Node owns the service; edge stack publishes Service Connect
      this.collectorService = new FargateService(this, 'CollectorService', {
        cluster: props.shared.cluster,
        taskDefinition: collectorTask,
        desiredCount: originalCollectorMin ? extraNumber(rawExtras, 'scaling.min') ?? 1 : 1,
        serviceName: collectorName,
        assignPublicIp: false,
        securityGroups: [this.collectorSecurityGroup],
        vpcSubnets: privateSubnets,
        minHealthyPercent: rolling.minHealthyPercent,
        maxHealthyPercent: rolling.maxHealthyPercent,
        circuitBreaker: rolling.circuitBreaker,
        healthCheckGracePeriod: Duration.seconds(grace),
        platformVersion: FargatePlatformVersion.LATEST,
      });
      omitEmptyLoadBalancers(this.collectorService);
      new CfnOutput(this, 'CollectorEndpoint', {
        value: this.collectorEndpoint ?? observeCollectorEndpoint(envKey, componentKey),
      });
      maybeAutoscaleService(this.collectorService, {
        ...extras,
        'scaling.min': originalCollectorMin ? extraNumber(rawExtras, 'scaling.min') ?? 1 : 1,
        'scaling.max': originalCollectorMin
          ? extraNumber(extras, 'scaling.max') ?? extraNumber(rawExtras, 'scaling.min') ?? 1
          : 1,
      });
    }

    if (!emitDashboard) {
      return;
    }

    const dashboardTask = new FargateTaskDefinition(this, 'DashboardTask', {
      family: dashboardName,
      cpu: extraNumber(extras, 'capacity.cpu') ?? 256,
      memoryLimitMiB: extraNumber(extras, 'capacity.memory') ?? 512,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });
    grantFargateExecutionRoleEcrPull(dashboardTask);

    const dashboardLogs = serviceLogGroup(
      this,
      'DashboardLogGroup',
      // @intent Include stackPrefix so multi-project staging does not collide
      buildServiceLogGroupName(props.profile.stackPrefix, componentKey, 'dashboard'),
      extras,
    );

    // @intent Apply uses pause; release publishes the package/fixture dashboard image
    dashboardTask.addContainer('Dashboard', {
      containerName: 'dashboard',
      image: ContainerImage.fromRegistry(OBSERVE_DASHBOARD_IMAGE),
      portMappings: [{ containerPort: dashboardPort, protocol: EcsProtocol.TCP, name: 'http' }],
      environment: {
        THONNAS_ENV: envKey,
      },
      logging: LogDriver.awsLogs({
        streamPrefix: 'dashboard',
        logGroup: dashboardLogs,
      }),
    });
    this.dashboardTaskDefinition = dashboardTask;

    // @intent Allow ALB to reach dashboard tasks after release attach
    this.dashboardSecurityGroup = new SecurityGroup(this, 'DashboardServiceSecurityGroup', {
      vpc: props.networking.vpc,
      allowAllOutbound: true,
      securityGroupName: `${dashboardName}-sg`,
    });
    if (props.shared.albSecurityGroup) {
      this.dashboardSecurityGroup.addIngressRule(
        props.shared.albSecurityGroup,
        Port.tcp(dashboardPort),
        'Allow ALB traffic',
      );
    }

    // @intent Metastore is Postgres (RelationalToObserve); scale like other HTTP services
    const dashboardDesired = extraNumber(extras, 'scaling.min') ?? httpDesiredCount(props.component, envKey);
    const dashboardService = new FargateService(this, 'DashboardService', {
      cluster: props.shared.cluster,
      taskDefinition: dashboardTask,
      desiredCount: dashboardDesired,
      serviceName: dashboardName,
      assignPublicIp: false,
      securityGroups: [this.dashboardSecurityGroup],
      vpcSubnets: privateSubnets,
      minHealthyPercent: rolling.minHealthyPercent,
      maxHealthyPercent: rolling.maxHealthyPercent,
      circuitBreaker: rolling.circuitBreaker,
      healthCheckGracePeriod: Duration.seconds(grace),
      platformVersion: FargatePlatformVersion.LATEST,
    });
    omitEmptyLoadBalancers(dashboardService);
    maybeAutoscaleService(dashboardService, extras);

    if (!props.shared.httpsListener) {
      return;
    }

    // @intent Leave dashboard TG empty on apply; pause must never sit on the edge
    const targetGroup = new ApplicationTargetGroup(this, 'DashboardTargetGroup', {
      targetGroupName: observeDashboardTargetGroupName(
        envKey,
        componentKey,
        props.profile.projectKey,
      ),
      port: dashboardPort,
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

    new ApplicationListenerRule(this, 'DashboardListenerRule', {
      listener: props.shared.httpsListener as ApplicationListener,
      action: ListenerAction.forward([targetGroup]),
      priority: listenerRulePriority(componentKey),
      conditions: hostname
        ? [ListenerCondition.hostHeaders([hostname])]
        : [ListenerCondition.pathPatterns(['/*'])],
    });

    // @intent Publish DNS for the dashboard host-header so the UI is reachable by name
    const zoneDomain = resolveHostedZoneDomain(extras, props.shared.rootDomain);
    if (hostname && zoneDomain && props.shared.loadBalancer) {
      addAlbHostnameAlias(this, 'DashboardAlbHostname', {
        hostname,
        hostedZoneDomain: zoneDomain,
        loadBalancer: props.shared.loadBalancer,
      });
    }
  }
}




