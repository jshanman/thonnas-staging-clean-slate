import { App, Stack, StackProps } from 'aws-cdk-lib';
import { DependencyGraph, PlannedResource, ResolvedCloudComponent, StrategyResolutionResult } from '../types';
import { ecrRepositoryName, resolveComponentInternalEnv } from '../utils/path-helpers';
import { buildEnvProfile } from './env-profiles';
import { NetworkingStack } from '../stacks/networking-stack';
import { EcsSharedStack, requiresAlbHttps } from '../stacks/ecs-shared-stack';
import { EcsServiceStack } from '../stacks/ecs-service-stack';
import { Ec2ServiceStack } from '../stacks/ec2-service-stack';
import { ComposeHostStack } from '../stacks/compose-host-stack';
import { ArtifactStack } from '../stacks/artifact-stack';
import { StaticSiteStack } from '../stacks/static-site-stack';
import { SignedUrlStack } from '../stacks/signed-url-stack';
import { StorageStack } from '../stacks/storage-stack';
import { RdsStack } from '../stacks/rds-stack';
import { DocDbStack } from '../stacks/docdb-stack';
import { RedisStack } from '../stacks/redis-stack';
import { TemporalStack } from '../stacks/temporal-stack';
import { ObserveStack, observeFamiliesFromSlots } from '../stacks/observe-stack';
import { ObserveToEcsStack } from '../stacks/observe-to-ecs-stack';
import { DbaFleetStack } from '../stacks/dba-fleet-stack';
import { DbaFleetToObserveStack } from '../stacks/dba-fleet-to-observe-stack';
import { MqttFleetStack } from '../stacks/mqtt-fleet-stack';
import { MqttFleetToEcsStack } from '../stacks/mqtt-fleet-to-ecs-stack';
import { RelationalToObserveStack } from '../stacks/relational-to-observe-stack';
import { RelationalToEcsStack } from '../stacks/relational-to-ecs-stack';
import { DocumentToEcsStack } from '../stacks/document-to-ecs-stack';
import { CacheToEcsStack } from '../stacks/cache-to-ecs-stack';
import { TemporalToEcsStack } from '../stacks/temporal-to-ecs-stack';
import type { ReleasedContainer } from '../stacks/released-container';
import { NlbStack } from '../stacks/nlb-stack';
import { EventsBusStack } from '../stacks/events-bus-stack';
import type { EventsBusQueuePlan } from '../events/events-bus-plan';
import path from 'node:path';
import fs from 'node:fs/promises';
import { GithubOidcStack, defaultGithubSubjectFilters } from '../stacks/github-oidc-stack';
import { loadCommittedExportDefaults } from '../identity/committed-config';
import { lookupGithubOidcProviderArn, resolveGithubNumericIds, subjectFiltersWithNumericIds } from '../identity/github-oidc-provider';

export interface CreateCdkAppOptions {
  env: string;
  graph: DependencyGraph;
  resolution: StrategyResolutionResult;
  imageTag: string;
  /** Git ref for compose-host checkout only (not hostnames/buckets; stack isolation uses deploy-slug per env profile). */
  gitTag?: string;
  /** Pre-validated slug for `{deploy-slug}` in routes/buckets and stack names when scope uses it. */
  deploySlug?: string;
  projectName?: string;
  accountId?: string;
  region?: string;
  rootDomain?: string;
  /** Project root for artifact deploy (resolve dist path); aligns with CLI --project-root. */
  projectRoot?: string;
  /** Optional CDK context (cert/dist leftover keys, hosted-zone lookup). */
  cdkContext?: Record<string, string | number | boolean | object>;
  /** Live released containers keyed by component so apply does not reset pause. */
  releasedContainers?: Record<string, ReleasedContainer>;
  /** When set, import this IAM OIDC provider instead of creating one. */
  existingProviderArn?: string;
  /** GitHub's immutable numeric owner id (see resolveGithubNumericIdsForSynth); builds the exact subject claim the real OIDC token uses. */
  githubOrgId?: string;
  /** GitHub's immutable numeric repo id (see resolveGithubNumericIdsForSynth). */
  githubRepoId?: string;
}

const mapRepositories = (resources: PlannedResource[]): Map<string, string> => {
  const map = new Map<string, string>();
  resources.forEach((resource) => {
    if (resource.kind === 'ecrRepository' && resource.component && typeof resource.props.name === 'string') {
      map.set(resource.component, resource.props.name as string);
    }
  });
  return map;
};

const requireEnv = (account?: string, region?: string): { account: string; region: string } => {
  const resolvedAccount = account ?? process.env.CDK_DEFAULT_ACCOUNT;
  const resolvedRegion = region ?? process.env.CDK_DEFAULT_REGION;
  if (!resolvedAccount || !resolvedRegion) {
    throw new Error(
      'AWS account/region missing. Provide --account-id and --region or set CDK_DEFAULT_ACCOUNT/CDK_DEFAULT_REGION.',
    );
  }
  return { account: resolvedAccount, region: resolvedRegion };
};

const getRepositoryName = (
  component: ResolvedCloudComponent,
  repositoryMap: Map<string, string>,
  projectName?: string,
): string => {
  return (
    repositoryMap.get(component.component) ??
    ecrRepositoryName(component.env, component.component, projectName)
  );
};

// @intent Data-plane needs VPC even without a container runtimeType
const DATA_CONSTRUCTS = new Set([
  'RdsPostgresInstance',
  'AuroraPostgresCluster',
  'AwsDocumentDbCluster',
  'ElasticacheRedisCluster',
  'TemporalServer',
  'ObserveIngest',
  'DbaFleet',
  'MqttFleet',
]);

// @intent Collect mqtt/ws/tcp from extras metadata only
const collectEdgeProtocols = (components: ResolvedCloudComponent[]): string[] =>
  Array.from(
    new Set(
      components.flatMap((c) => c.metadata.protocols ?? []).filter((p) => p === 'mqtt' || p === 'ws' || p === 'tcp'),
    ),
  );

const needsNetworking = (components: ResolvedCloudComponent[]): boolean =>
  components.some(
    (c) =>
      c.scope === 'service' &&
      (c.construct === 'ComposeHostEc2' ||
        c.metadata.runtimeType === 'ecs-fargate' ||
        c.metadata.runtimeType === 'ec2-docker' ||
        DATA_CONSTRUCTS.has(c.construct)),
  );

// @intent Build AWS CDK app from dependency graph + resolution metadata
export const createCdkApp = (options: CreateCdkAppOptions): App => {
  // @intent CDK's default ("strong") cross-stack reference mode uses an ExportWriter/ExportReader
  // custom-resource pair that locks the producing stack against ANY replacement-triggering change
  // as long as anything it exports is imported elsewhere -- even when the specific resource that
  // changed isn't the one being exported (confirmed live: a DbaFleet EC2 instance's UserData
  // update alone aborted the whole deploy with "Cannot delete export ...DbaFleetSg... in use by
  // ...DbaFleetToObserve", though the changeset touched only the instance). This is exactly what
  // makes `--target-component` unreliable across independently-evolving stacks. "weak" mode reads
  // the producer's output directly (Fn::GetStackOutput) with no such lock -- but per CDK's own
  // docs the flag is read from the CONSUMER's context, so producer and consumer must switch
  // together; jumping straight to "weak" just moves the same lock to whichever stack updates
  // first while its consumers are still on the old mechanism (confirmed live: dbt-postgresRds
  // hit the identical export-in-use failure switching directly). "both" is the documented
  // transitional value -- producer keeps writing the old mechanism (nothing yet importing it
  // breaks) while consumers switch to the lock-free read.
  //
  // "both" is also, deliberately, this codebase's resting state, not just a layover: flipping to
  // "weak" is only safe once EVERY stack that exists ANYWHERE in the account -- not just the ones
  // in a given --target-component run -- has redeployed under "both" (a producer under "weak"
  // stops writing the old-style export, and CloudFormation refuses to drop an export any live
  // stack still imports the old way, which reproduces the exact failure this migration exists to
  // fix). Any stack that stays out of scope of a deploy for unrelated reasons (blocked secret,
  // deliberately excluded component) is a stack this can never verify is ready, so treat "both"
  // as done, not "flip to weak once convenient." "both" already fully solves the actual problem
  // (--target-component no longer hits export-in-use lock failures); "weak" only buys the ability
  // to later replace/rename an exported resource without a two-phase dance, which is not something
  // this migration was blocked on. Caller-supplied cdkContext can still override this per invocation.
  const app = new App({
    context: { '@aws-cdk/core:defaultCrossStackReferences': 'both', ...(options.cdkContext ?? {}) },
  });
  const profile = buildEnvProfile(options.env, options.resolution.components, options.deploySlug, options.projectName);
  const envConfig = requireEnv(options.accountId, options.region);
  const stackProps: StackProps = { env: envConfig };
  const repositoryMap = mapRepositories(options.resolution.resources);

  // @intent Use 2 AZs whenever Networking exists so we never remove a subnet export that Wiring (or a prior deploy) may still import
  const networkingStackName = `${profile.networkingStackPrefix}Networking`;
  // @intent Wiring (EcsShared) always uses enableAlb when Networking exists; ALB requires ≥2 subnets in 2 AZs
  const networking = needsNetworking(options.resolution.components)
    ? new NetworkingStack(app, networkingStackName, {
        ...stackProps,
        profile,
        maxAzs: 2,
      })
    : undefined;

  // @intent Create Wiring (formerly EcsShared) whenever Networking exists so both public subnet exports are emitted (ALB references both); avoids CF export removal when Wiring stack already exists in AWS from a prior deploy. enableAlb true so ALB is created and references both subnets.
  const wiringStackName = `${profile.wiringStackPrefix}Wiring`;
  const albCertificateArn =
    process.env.THONNAS_ALB_CERTIFICATE_ARN ||
    options.resolution.components.find((c) => c.metadata.certificateArn)?.metadata.certificateArn;
  // @intent Enable the ALB whenever this env needs HTTPS Fargate (staging/prod) and we have
  // either a known cert ARN or a root domain to self-request+DNS-validate a new one from --
  // matching EcsSharedStack's own supported bootstrap path (Certificate + CertificateValidation
  // .fromDns). Previously this only enabled the ALB when a certArn already existed, which meant
  // a brand-new domain/project could never get its first cert requested at all: the one
  // construct that requests it (inside EcsSharedStack, gated on enableAlb) never got created,
  // so `infra plan` stayed permanently "blocked: certStatus=missing" with no way forward short
  // of supplying a certArn from somewhere else first. Only remaining throw case inside
  // EcsSharedStack (requiresAlbHttps && !certArn && !rootDomain) is now unreachable here since
  // this condition already requires one of the two.
  const enableAlb =
    Boolean(albCertificateArn?.trim()) ||
    (requiresAlbHttps(profile) && Boolean(options.rootDomain?.trim()));
  const shared = networking
    ? new EcsSharedStack(app, wiringStackName, {
        ...stackProps,
        networking,
        profile,
        rootDomain: options.rootDomain,
        enableAlb,
        certificateArn: albCertificateArn,
      })
    : undefined;

  // @intent Collect component names that use ComposeHost so we do not create a separate StorageStack for them (bucket lives in ComposeHostStack)
  const composeHostComponents = options.resolution.components.filter(
    (c) => c.construct === 'ComposeHostEc2',
  );
  const composeHostComponentNames = new Set(composeHostComponents.map((c) => c.component));

  const fargateStacks: EcsServiceStack[] = [];
  // @intent Edges import ServiceSg by name; depend on hosts so first apply does not race the export
  const dependOnServiceSgExports = (edge: Stack) => {
    for (const host of fargateStacks) edge.addDependency(host);
  };
  const ec2StacksByComponent = new Map<string, Ec2ServiceStack>();

  const eventsBusResource = options.resolution.resources.find((r) => r.kind === 'snsSqsEventBus');
  const eventsBusQueues = Array.isArray(eventsBusResource?.props?.queues)
    ? (eventsBusResource?.props?.queues as EventsBusQueuePlan[])
    : [];
  const eventsBus =
    eventsBusResource && typeof eventsBusResource.props?.topicName === 'string'
      ? {
          topicName: eventsBusResource.props.topicName as string,
          queueNames: eventsBusQueues.map((q) => q.queueName),
          dlqNames: eventsBusQueues.map((q) => q.dlqName),
          queues: eventsBusQueues.map((q) => ({ consumerId: q.consumerId, queueName: q.queueName })),
        }
      : undefined;

  // @intent Single shared EC2 host runs the whole aggregated docker-compose file for every
  // ComposeHostEc2 component -- create exactly one ComposeHostStack (fixed stack name; a second
  // `new ComposeHostStack` with the same name throws a duplicate-construct error), merging each
  // component's published services rather than instantiating a stack per component. composeFile,
  // gitRepositoryUrl, workingDirectory etc. are identical across components (same shared host);
  // only publishedServices genuinely differs per component.
  if (composeHostComponents.length > 0) {
    if (!networking) {
      throw new Error(
        `ComposeHost requires Networking stack, but none was created. Ensure at least one component needs VPC/ALB.`,
      );
    }
    const [primaryComposeHostComponent, ...restComposeHostComponents] = composeHostComponents;
    const primaryCompose = primaryComposeHostComponent.metadata.compose;
    if (!primaryCompose) {
      throw new Error('Compose host metadata missing; ensure strategy extras are set.');
    }
    const mergedPublishedServices = [
      ...(primaryCompose.publishedServices ?? []),
      ...restComposeHostComponents.flatMap((c) => c.metadata.compose?.publishedServices ?? []),
    ];
    // @intent All infra.storage buckets for this env: single ComposeHost runs whole compose file (all services), so it needs every storage bucket (idempotent: CF only creates when missing)
    const storageBuckets = options.resolution.resources.filter((r) => r.kind === 's3StorageBucket');
    const s3StorageBucketNames = storageBuckets
      .map((r) => r.props?.bucket as string)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
    const config = {
      ...primaryCompose,
      publishedServices: mergedPublishedServices,
      ...(s3StorageBucketNames.length > 0 ? { s3StorageBucketNames } : {}),
      ...(eventsBus ? { eventsBus } : {}),
      ...(options.deploySlug ? { deploySlug: options.deploySlug } : {}),
    };
    // @intent When ComposeHost scope differs from Networking scope, CDK automatically creates cross-stack references (e.g., env-scoped Networking shared by git-tag-scoped ComposeHost stacks)
    const composeHostStackName = `${profile.composeHostStackPrefix}ComposeHost`;
    new ComposeHostStack(app, composeHostStackName, {
      ...stackProps,
      profile,
      component: primaryComposeHostComponent,
      networking,
      config,
    });
  }

  options.resolution.components
    .filter((component) => component.scope === 'service')
    .forEach((component) => {
      if (component.construct === 'ComposeHostEc2') {
        // @intent Already created once, above (merged publishedServices across all ComposeHostEc2 components)
        return;
      }

      if (component.metadata.runtimeType === 'ecs-fargate' && shared && networking) {
        fargateStacks.push(
          new EcsServiceStack(app, `${profile.stackPrefix}${component.component}Service`, {
            ...stackProps,
            profile,
            component,
            networking,
            shared,
                        // @intent Prefer planned name; fallback uses same ecrRepositoryName as plan/release
            repositoryName: getRepositoryName(
              component,
              repositoryMap,
              options.projectName ?? profile.projectKey,
            ),
            imageTag: options.imageTag,
            eventsBus,
            releasedContainer: options.releasedContainers?.[component.component],
            internalEnv: options.projectRoot
              ? resolveComponentInternalEnv(options.projectRoot, component.component, options.env)
              : undefined,
          }),
        );
      }

      if (component.metadata.runtimeType === 'ec2-docker' && networking) {
        const storageBuckets = options.resolution.resources.filter(
          (r) => r.kind === 's3StorageBucket' && r.component === component.component,
        );
        const bucketNames = storageBuckets
          .map((r) => r.props?.bucket as string)
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
        const ec2Stack = new Ec2ServiceStack(app, `${profile.stackPrefix}${component.component}Ec2`, {
          ...stackProps,
          profile,
          component,
          networking,
          repositoryName: getRepositoryName(
            component,
            repositoryMap,
            options.projectName ?? profile.projectKey,
          ),
          imageTag: options.imageTag,
          region: envConfig.region,
          accountId: envConfig.account,
          bucketNames: bucketNames.length > 0 ? bucketNames : undefined,
        });
        // @intent Defer StorageStack deps until storage stacks exist below
        ec2StacksByComponent.set(component.component, ec2Stack);
      }

    });

  // @intent Data-plane and platform stacks (RDS / DocDB / Redis / Temporal / observe / NLB)
  const wantsRds = options.resolution.components.some((c) => c.construct === 'RdsPostgresInstance');
  if (wantsRds && !networking) {
    throw new Error(
      'RdsPostgresInstance requires a Networking stack (VPC / private subnets). Data-plane needs VPC even without a container runtimeType.',
    );
  }
  const wantsDocDb = options.resolution.components.some((c) => c.construct === 'AwsDocumentDbCluster');
  if (wantsDocDb && !networking) {
    throw new Error(
      'AwsDocumentDbCluster requires a Networking stack (VPC / private subnets). Data-plane needs VPC even without a container runtimeType.',
    );
  }
  const wantsRedis = options.resolution.components.some((c) => c.construct === 'ElasticacheRedisCluster');
  if (wantsRedis && !networking) {
    throw new Error(
      'ElasticacheRedisCluster requires a Networking stack (VPC / private subnets). Data-plane needs VPC even without a container runtimeType.',
    );
  }
  const wantsTemporal = options.resolution.components.some((c) => c.construct === 'TemporalServer');
  if (wantsTemporal && !networking) {
    throw new Error(
      'TemporalServer requires a Networking stack (VPC / private subnets). Data-plane needs VPC even without a container runtimeType.',
    );
  }
  const wantsDbaFleet = options.resolution.components.some((c) => c.construct === 'DbaFleet');
  if (wantsDbaFleet && !networking) {
    throw new Error(
      'DbaFleet requires a Networking stack (VPC / private subnets). Data-plane needs VPC even without a container runtimeType.',
    );
  }
  const wantsMqttFleet = options.resolution.components.some((c) => c.construct === 'MqttFleet');
  if (wantsMqttFleet && !networking) {
    throw new Error(
      'MqttFleet requires a Networking stack (VPC / private subnets). Data-plane needs VPC even without a container runtimeType.',
    );
  }
  const rdsStacks: RdsStack[] = [];
  const docDbStacks: DocDbStack[] = [];
  const redisStacks: RedisStack[] = [];
  const dbaFleetStacks: DbaFleetStack[] = [];
  const mqttFleetStacks: MqttFleetStack[] = [];
  const temporalStacks: TemporalStack[] = [];
  const uniquePlatform = new Set<string>();
  // @intent Pass real Fargate SG ids into data-plane extras (never a planned name string)
  const fargatePeerIds = fargateStacks.map((stack) => stack.serviceSecurityGroup.securityGroupId);
  const extrasWithFargatePeers = (extras?: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (fargatePeerIds.length === 0) return extras;
    const existing = Array.isArray(extras?.peerSecurityGroupIds)
      ? extras.peerSecurityGroupIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    return { ...(extras ?? {}), peerSecurityGroupIds: [...existing, ...fargatePeerIds] };
  };
  options.resolution.components
    .filter((c) => c.scope === 'service')
    .forEach((component) => {
      if (component.construct === 'AuroraPostgresCluster') {
        throw new Error(
          'AuroraPostgresCluster is not implemented (Phase 3 stub). Use engine: postgres for RdsStack.',
        );
      }
      if (!networking) return;
      if (component.construct === 'RdsPostgresInstance') {
        // @intent Do not pass Fargate SG ids here — RelationalToEcs owns that peer link (avoids CFN cycles)
        rdsStacks.push(
          new RdsStack(app, `${profile.stackPrefix}${component.component}Rds`, {
            ...stackProps,
            profile,
            component,
            networking,
            extras: component.metadata.extras,
          }),
        );
      }
      if (component.construct === 'AwsDocumentDbCluster') {
        // @intent Do not pass Fargate SG ids here — DocumentToEcs owns that peer link (avoids CFN cycles)
        docDbStacks.push(
          new DocDbStack(app, `${profile.stackPrefix}${component.component}DocDb`, {
            ...stackProps,
            profile,
            component,
            networking,
            extras: component.metadata.extras,
          }),
        );
      }
      if (component.construct === 'ElasticacheRedisCluster') {
        // @intent Do not pass Fargate SG ids here — CacheToEcs owns that peer link (avoids CFN cycles)
        redisStacks.push(
          new RedisStack(app, `${profile.stackPrefix}${component.component}Redis`, {
            ...stackProps,
            profile,
            component,
            networking,
            extras: component.metadata.extras,
          }),
        );
      }
      if (component.construct === 'DbaFleet') {
        dbaFleetStacks.push(
          new DbaFleetStack(app, `${profile.stackPrefix}${component.component}DbaFleet`, {
            ...stackProps,
            profile,
            component,
            networking,
            extras: extrasWithFargatePeers(component.metadata.extras),
          }),
        );
      }
      if (component.construct === 'MqttFleet') {
        // @intent Deliberately NOT extrasWithFargatePeers (unlike DbaFleet) -- MqttFleetToEcsStack
        // is the sole owner of ECS peer SG ingress for this fleet type. DbaFleet has no separate
        // "-to-ecs" edge stack, so it must self-open peer access; if MqttFleetStack also did, the
        // fleet would depend on every ECS peer (for the SG import) while MqttFleetToEcsStack
        // separately makes each peer depend back on the fleet (for the injected host/secret env
        // vars) -- a genuine CloudFormation dependency cycle, not just a synth quirk. Confirmed by
        // hitting it live: CDK's own DependencyCycle error, this exact edge pair.
        mqttFleetStacks.push(
          new MqttFleetStack(app, `${profile.stackPrefix}${component.component}MqttFleet`, {
            ...stackProps,
            profile,
            component,
            networking,
            extras: component.metadata.extras,
          }),
        );
      }
    });
  // @intent Create Observe after DbaFleet so visit order cannot drop the fleet host/SG
  if (shared && networking) {
    const observeStacks: Array<{
      stack: ObserveStack;
      component: string;
      emitCollector: boolean;
      emitDashboard: boolean;
    }> = [];
    options.resolution.components
      .filter((c) => c.scope === 'service' && c.construct === 'ObserveIngest')
      .forEach((component) => {
        const key = `${component.component}:observe`;
        if (uniquePlatform.has(key)) return;
        uniquePlatform.add(key);
        // @intent Collect sibling observe slots so one stack can emit both families
        const siblings = options.resolution.components.filter(
          (item) => item.construct === 'ObserveIngest' && item.component === component.component,
        );
        const families = observeFamiliesFromSlots(siblings);
        const hostnameHost = siblings.find((item) => item.metadata.hostname?.trim()) ?? component;
        const extras = Object.assign(
          {},
          ...siblings.map((item) => item.metadata.extras ?? {}),
          component.metadata.extras ?? {},
        );
        const observe = new ObserveStack(app, `${profile.stackPrefix}${component.component}Observe`, {
          ...stackProps,
          profile,
          component: {
            ...component,
            metadata: {
              ...component.metadata,
              hostname: hostnameHost.metadata.hostname,
              extras,
            },
          },
          networking,
          shared,
          emitCollector: families.collector,
          emitDashboard: families.dashboard,
          repositoryName: getRepositoryName(component, repositoryMap, options.projectName ?? profile.projectKey),
        });
        observeStacks.push({
          stack: observe,
          component: component.component,
          emitCollector: families.collector,
          emitDashboard: families.dashboard,
        });
      });
    // @intent Emit ObserveToEcs edge when collector family + Wiring exist
    for (const entry of observeStacks) {
      if (!entry.emitCollector) continue;
      dependOnServiceSgExports(
        new ObserveToEcsStack(app, `${profile.stackPrefix}${entry.component}ObserveToEcs`, {
          ...stackProps,
          profile,
          networking,
          shared,
          observe: entry.stack,
          ecsPeers: fargateStacks.map((stack) => ({
            serviceSecurityGroupExportName: stack.serviceSecurityGroupExportName,
          })),
          collectorComponent: entry.component,
          collectorEnv: profile.envKey,
        }),
      );
    }
    // @intent Emit DbaFleet→Observe edge when fleet + collector/dashboard exist
    const fleet = dbaFleetStacks[0];
    if (fleet) {
      const fleetComponent = options.resolution.components.find((c) => c.construct === 'DbaFleet');
      const fleetExtras = (fleetComponent?.metadata.extras ?? {}) as Record<string, unknown>;
      const servicePorts = Array.isArray(fleetExtras.servicePorts)
        ? fleetExtras.servicePorts
            .map((item) => (typeof item === 'number' ? item : Number(item)))
            .filter((n): n is number => Number.isFinite(n) && n > 0)
        : undefined;
      for (const entry of observeStacks) {
        if (!entry.emitCollector && !entry.emitDashboard) continue;
        new DbaFleetToObserveStack(app, `${profile.stackPrefix}${entry.component}DbaFleetToObserve`, {
          ...stackProps,
          profile,
          networking,
          fleet,
          observe: entry.stack,
          servicePorts: servicePorts?.length ? servicePorts : undefined,
        });
      }
    }
    // @intent Emit Relational→Observe edge when RDS + dashboard family exist
    const rdsForObserve = rdsStacks[0];
    if (rdsForObserve) {
      for (const entry of observeStacks) {
        if (!entry.emitDashboard) continue;
        new RelationalToObserveStack(app, `${profile.stackPrefix}${entry.component}RelationalToObserve`, {
          ...stackProps,
          profile,
          networking,
          rds: rdsForObserve,
          observe: entry.stack,
        });
      }
    }
  }
  // @intent Emit Relational→ECS edge when RDS + managed-host Fargate peers exist
  if (networking && rdsStacks[0] && fargateStacks.length > 0) {
    const rdsComponent = options.resolution.components.find((c) => c.construct === 'RdsPostgresInstance');
    const edgeName = rdsComponent?.component ?? 'relational';
    dependOnServiceSgExports(
      new RelationalToEcsStack(app, `${profile.stackPrefix}${edgeName}RelationalToEcs`, {
        ...stackProps,
        profile,
        networking,
        rds: rdsStacks[0],
        ecsPeers: fargateStacks.map((stack) => ({
          taskDefinition: stack.taskDefinition,
          serviceSecurityGroupExportName: stack.serviceSecurityGroupExportName,
        })),
      }),
    );
  }
  // @intent Emit Document→ECS edge when DocDB + managed-host Fargate peers exist
  if (networking && docDbStacks[0] && fargateStacks.length > 0) {
    const docComponent = options.resolution.components.find((c) => c.construct === 'AwsDocumentDbCluster');
    const edgeName = docComponent?.component ?? 'document';
    dependOnServiceSgExports(
      new DocumentToEcsStack(app, `${profile.stackPrefix}${edgeName}DocumentToEcs`, {
        ...stackProps,
        profile,
        networking,
        docdb: docDbStacks[0],
        ecsPeers: fargateStacks.map((stack) => ({
          taskDefinition: stack.taskDefinition,
          serviceSecurityGroupExportName: stack.serviceSecurityGroupExportName,
        })),
      }),
    );
  }
  // @intent Emit Cache→ECS edge when Redis + managed-host Fargate peers exist
  if (networking && redisStacks[0] && fargateStacks.length > 0) {
    const cacheComponent = options.resolution.components.find((c) => c.construct === 'ElasticacheRedisCluster');
    const edgeName = cacheComponent?.component ?? 'cache';
    dependOnServiceSgExports(
      new CacheToEcsStack(app, `${profile.stackPrefix}${edgeName}CacheToEcs`, {
        ...stackProps,
        profile,
        networking,
        redis: redisStacks[0],
        ecsPeers: fargateStacks.map((stack) => ({
          taskDefinition: stack.taskDefinition,
          serviceSecurityGroupExportName: stack.serviceSecurityGroupExportName,
        })),
      }),
    );
  }
  // @intent Emit MqttFleet→ECS edge when an MQTT fleet + managed-host Fargate peers exist --
  // injects the broker-admin credential as a real ECS-native secret so backend consumers (e.g.
  // api-go's tm-mqtt module) authenticate with the actual broker user instead of connecting
  // anonymously (which the fleet's mandatory built-in-database auth would otherwise reject).
  if (networking && mqttFleetStacks[0] && fargateStacks.length > 0) {
    const mqttComponent = options.resolution.components.find((c) => c.construct === 'MqttFleet');
    const edgeName = mqttComponent?.component ?? 'mqtt';
    const mqttExtras = (mqttComponent?.metadata.extras ?? {}) as Record<string, unknown>;
    const mqttServicePorts = Array.isArray(mqttExtras.servicePorts)
      ? mqttExtras.servicePorts
          .map((item) => (typeof item === 'number' ? item : Number(item)))
          .filter((n): n is number => Number.isFinite(n) && n > 0)
      : [];
    dependOnServiceSgExports(
      new MqttFleetToEcsStack(app, `${profile.stackPrefix}${edgeName}MqttFleetToEcs`, {
        ...stackProps,
        profile,
        networking,
        mqttFleet: mqttFleetStacks[0],
        servicePorts: mqttServicePorts.length ? mqttServicePorts : [1883],
        ecsPeers: fargateStacks.map((stack) => ({
          taskDefinition: stack.taskDefinition,
          serviceSecurityGroupExportName: stack.serviceSecurityGroupExportName,
        })),
      }),
    );
  }
  // @intent Create Temporal after every RDS stack so collector order cannot drop the secret
  if (wantsTemporal) {
    if (!shared) {
      throw new Error('Temporal requires an ECS cluster (managed-host / Fargate wiring).');
    }
    if (!networking) {
      throw new Error('Temporal requires a Networking stack (VPC / private subnets).');
    }
    const rds = rdsStacks[0];
    // @intent Plan already emitted blocked; omit Temporal instead of throwing at synth
    if (rds) {
      options.resolution.components
        .filter((c) => c.scope === 'service' && c.construct === 'TemporalServer')
        .forEach((component) => {
          const key = `${component.component}:temporal`;
          if (uniquePlatform.has(key)) return;
          uniquePlatform.add(key);
          temporalStacks.push(
            new TemporalStack(app, `${profile.stackPrefix}${component.component}Temporal`, {
              ...stackProps,
              profile,
              component,
              networking,
              shared,
              rds,
            }),
          );
        });
    }
  }
  // @intent Emit Temporal→ECS edge when Temporal + managed-host Fargate peers exist -- see
  // temporal-to-ecs-stack.ts for why this is required (the real Cloud Map DNS name is only known
  // at synth time, so it cannot be hardcoded in a module's own thonnas-config.json).
  if (temporalStacks[0] && fargateStacks.length > 0) {
    const temporalComponent = options.resolution.components.find((c) => c.construct === 'TemporalServer');
    const temporalEdgeName = temporalComponent?.component ?? 'temporal';
    new TemporalToEcsStack(app, `${profile.stackPrefix}${temporalEdgeName}TemporalToEcs`, {
      ...stackProps,
      profile,
      temporal: temporalStacks[0],
      ecsPeers: fargateStacks.map((stack) => ({
        taskDefinition: stack.taskDefinition,
      })),
    });
  }
  // @intent Emit NLB only from extras protocols mqtt/ws/tcp (HTTP-only stays ALB)
  const edgeProtocols = collectEdgeProtocols(options.resolution.components);
  if (networking && edgeProtocols.length > 0) {
    // @intent Register the MQTT fleet's real node IPs as NLB targets when one was planned, so the
    // listener actually load-balances traffic instead of shipping empty (always-refusing) target
    // groups. Only one MqttFleet is expected per env today; first stack wins if more ever exist.
    const mqttTargetIps = mqttFleetStacks[0]?.nodePrivateIps;
    new NlbStack(app, `${profile.stackPrefix}EdgeNlb`, {
      ...stackProps,
      profile,
      networking,
      protocols: edgeProtocols,
      mqttTargetIps,
      certificateArn: albCertificateArn,
    });
  }

  // SignedUrlStack per component with infra.api.storage-temp-url
  const storageTempUrlComponentNames = new Set(
    options.resolution.components
      .filter((c) => c.construct === 'StorageTempUrlApi')
      .map((c) => c.component),
  );
  storageTempUrlComponentNames.forEach((componentName) => {
    const firstComponent = options.resolution.components.find(
      (c) => c.component === componentName && c.construct === 'StorageTempUrlApi',
    );
    if (!firstComponent || !options.projectRoot) return;
    const tempUrlResources = options.resolution.resources.filter(
      (r) => r.component === componentName && r.kind === 'storageTempUrlApi',
    );
    if (tempUrlResources.length === 0) return;
    const stackEnv = { ...stackProps.env!, region: 'us-east-1' as const };
    new SignedUrlStack(app, `${profile.stackPrefix}${componentName}SignedUrl`, {
      ...stackProps,
      env: stackEnv,
      profile,
      component: firstComponent,
      resources: options.resolution.resources.filter((r) => r.component === componentName),
      projectRoot: options.projectRoot,
    });
  });

  // @intent Emit StaticSite only for s3StaticSiteDeployment; Artifact never owns CloudFront
  const staticSiteComponentNames = new Set(
    options.resolution.resources
      .filter((r) => r.kind === 's3StaticSiteDeployment' && r.component)
      .map((r) => r.component as string),
  );
  const artifactComponentNames = new Set<string>();
  for (const c of options.resolution.components) {
    if (c.construct === 'ArtifactDeploy') artifactComponentNames.add(c.component);
    if (c.construct === 'S3WebsiteBucket' && !staticSiteComponentNames.has(c.component)) {
      artifactComponentNames.add(c.component);
    }
  }
  for (const r of options.resolution.resources) {
    if (r.kind === 's3ArtifactDeployment' && r.component) artifactComponentNames.add(r.component);
    if (r.kind === 's3WebsiteBucket' && r.component && !staticSiteComponentNames.has(r.component)) {
      artifactComponentNames.add(r.component);
    }
  }
  // StorageStack only when there is no ComposeHost (when ComposeHost exists, all s3StorageBucket buckets are created there so EC2 role has access)
  const storageStackByComponent = new Map<string, StorageStack>();
  const hasComposeHost = composeHostComponentNames.size > 0;
  const storageComponentNames = new Set(
    hasComposeHost
      ? []
      : options.resolution.components
          .filter((c) => c.construct === 'S3StorageBucket')
          .map((c) => c.component),
  );
  storageComponentNames.forEach((componentName) => {
    const storageResources = options.resolution.resources.filter(
      (r) => r.component === componentName && r.kind === 's3StorageBucket',
    );
    if (storageResources.length === 0) return;
    const firstComponent = options.resolution.components.find(
      (c) => c.component === componentName && c.construct === 'S3StorageBucket',
    );
    if (!firstComponent) return;
    const storageStack = new StorageStack(app, `${profile.stackPrefix}${componentName}Storage`, {
      ...stackProps,
      profile,
      component: firstComponent,
      resources: storageResources,
    });
    storageStackByComponent.set(componentName, storageStack);
  });
  // @intent Wire EC2 → Storage after both maps exist (TDZ-safe)
  for (const [componentName, ec2Stack] of ec2StacksByComponent) {
    const depStorage = storageStackByComponent.get(componentName);
    if (depStorage) ec2Stack.addDependency(depStorage);
  }

  const artifactStacks = new Map<string, ArtifactStack>();
  artifactComponentNames.forEach((componentName) => {
    const firstComponent = options.resolution.components.find(
      (c) =>
        c.component === componentName &&
        (c.construct === 'ArtifactDeploy' || c.construct === 'S3WebsiteBucket'),
    );
    if (!firstComponent || !options.projectRoot) return;
    const artifactResources = options.resolution.resources.filter(
      (r) =>
        r.component === componentName &&
        (r.kind === 's3WebsiteBucket' ||
          r.kind === 'route53AliasForS3' ||
          r.kind === 's3ArtifactDeployment'),
    );
    if (artifactResources.length > 0) {
      const artifactStack = new ArtifactStack(app, `${profile.stackPrefix}${componentName}Artifact`, {
        ...stackProps,
        profile,
        component: firstComponent,
        resources: artifactResources,
        projectRoot: options.projectRoot,
      });
      artifactStacks.set(componentName, artifactStack);
    }
  });

  staticSiteComponentNames.forEach((componentName) => {
    const firstComponent =
      options.resolution.components.find(
        (c) => c.component === componentName && c.construct === 'StaticSite',
      ) ?? options.resolution.components.find((c) => c.component === componentName);
    if (!firstComponent) return;
    const staticResources = options.resolution.resources.filter(
      (r) =>
        r.component === componentName &&
        (r.kind === 's3WebsiteBucket' ||
          r.kind === 'route53AliasForS3' ||
          r.kind === 's3StaticSiteDeployment'),
    );
    if (staticResources.length === 0) return;
    // @intent CloudFront only accepts ACM certs from us-east-1
    const stackEnv = { ...stackProps.env!, region: 'us-east-1' as const };
    const staticStack = new StaticSiteStack(app, `${profile.stackPrefix}${componentName}StaticSite`, {
      ...stackProps,
      env: stackEnv,
      profile,
      component: firstComponent,
      resources: staticResources,
      importOriginBucket: artifactStacks.has(componentName),
    });
    const artifactStack = artifactStacks.get(componentName);
    if (artifactStack) staticStack.addDependency(artifactStack);
  });

  const eventsBusResources = options.resolution.resources.filter((resource) => resource.kind === 'snsSqsEventBus');
  eventsBusResources.forEach((resource) => {
    const topicName = typeof resource.props?.topicName === 'string' ? resource.props.topicName.trim() : '';
    if (!topicName) return;
    const queues = Array.isArray(resource.props?.queues)
      ? (resource.props.queues as EventsBusQueuePlan[])
      : [];
    new EventsBusStack(app, `${profile.stackPrefix}EventsBus`, {
      ...stackProps,
      profile,
      topicName,
      queues,
    });
  });

  const componentDir = options.projectRoot
    ? path.join(options.projectRoot, 'components', 'infra-cdk')
    : process.cwd();
  const committed = loadCommittedExportDefaults(componentDir, options.env);
  const githubOrg =
    process.env.INFRA_CDK_GITHUB_ORG?.trim() || committed.INFRA_CDK_GITHUB_ORG?.trim();
  const githubRepo =
    process.env.INFRA_CDK_GITHUB_REPO?.trim() || committed.INFRA_CDK_GITHUB_REPO?.trim();
  const oidcAudience =
    process.env.INFRA_CDK_OIDC_AUDIENCE?.trim() ||
    committed.INFRA_CDK_OIDC_AUDIENCE?.trim() ||
    'sts.amazonaws.com';
  const existingProviderArn =
    options.existingProviderArn?.trim() ||
    process.env.INFRA_CDK_OIDC_PROVIDER_ARN?.trim() ||
    committed.INFRA_CDK_OIDC_PROVIDER_ARN?.trim() ||
    undefined;
  const subjectOverride =
    process.env.INFRA_CDK_OIDC_SUBJECT?.trim() || committed.INFRA_CDK_OIDC_SUBJECT?.trim();
  const oidcResources = options.resolution.resources.filter((resource) => resource.kind === 'githubOidcIdentity');
  const githubIssuer = oidcResources.some((resource) => {
    const issuer = resource.props?.issuer;
    return issuer == null || issuer === 'github';
  });
  // @intent A missing org/repo means this specific stack's precondition can't be met (e.g. a
  // disposable local project with no real GitHub remote) -- it must never abort synthesis of
  // every other already-configured stack in this app. Skip just the OIDC stack and warn; every
  // other family (Networking, Redis, Rds, Observe, fleets, EdgeNlb, etc.) still deploys.
  if (options.env !== 'development' && oidcResources.length > 0 && githubIssuer && (!githubOrg || !githubRepo)) {
    console.warn(
      '[cdk] Skipping GithubOidc stack: infra.identity.oidc is planned but INFRA_CDK_GITHUB_ORG / ' +
        'INFRA_CDK_GITHUB_REPO are empty. Run `thonnas infra bootstrap --env` or set those config ' +
        'values, then re-apply, to provision it.',
    );
  }
  if (options.env !== 'development' && oidcResources.length > 0 && githubIssuer && githubOrg && githubRepo) {
    const numericOrgId = options.githubOrgId?.trim() || committed.INFRA_CDK_GITHUB_ORG_ID?.trim();
    const numericRepoId = options.githubRepoId?.trim() || committed.INFRA_CDK_GITHUB_REPO_ID?.trim();
    const subjectFilters = subjectOverride
      ? subjectOverride.split(',').map((value) => value.trim()).filter(Boolean)
      : numericOrgId && numericRepoId
        ? subjectFiltersWithNumericIds(githubOrg, githubRepo, { orgId: numericOrgId, repoId: numericRepoId }, options.env)
        : defaultGithubSubjectFilters(githubOrg, githubRepo, options.env);
    // @intent Component-agnostic: derive the SSM target tag(s) from whichever components actually
    // resolved to a compose-host instance this env, using the exact same Name-tag formula the
    // instance itself is given (see compose-host-stack.ts's `instanceName`) — never a hardcoded
    // component or project name.
    const ssmTargetNameTags = options.resolution.components
      .filter((component) => component.construct === 'ComposeHostEc2')
      .map((component) => `${profile.stackPrefix}-${component.component}-compose`);
    new GithubOidcStack(app, `${profile.stackPrefix}GithubOidc`, {
      ...stackProps,
      envName: options.env,
      githubOrg,
      githubRepo,
      audience: oidcAudience,
      subjectFilters,
      existingProviderArn,
      ssmTargetNameTags,
    });
  }

  app.synth();
  return app;
};

/** @intent Import the account GitHub OIDC IdP when it already exists so apply does not fail */
export async function resolveGithubOidcProviderArnForSynth(
  options: CreateCdkAppOptions,
): Promise<string | undefined> {
  const componentDir = options.projectRoot
    ? path.join(options.projectRoot, 'components', 'infra-cdk')
    : process.cwd();
  const committed = loadCommittedExportDefaults(componentDir, options.env);
  const configured =
    options.existingProviderArn?.trim() ||
    process.env.INFRA_CDK_OIDC_PROVIDER_ARN?.trim() ||
    committed.INFRA_CDK_OIDC_PROVIDER_ARN?.trim() ||
    undefined;
  if (configured) {
    return configured;
  }
  const needsGithubOidc = options.resolution.resources.some((resource) => {
    if (resource.kind !== 'githubOidcIdentity') return false;
    const issuer = resource.props?.issuer;
    return issuer == null || issuer === 'github';
  });
  if (!needsGithubOidc) {
    return undefined;
  }
  try {
    const found = await lookupGithubOidcProviderArn({ region: options.region });
    if (found) {
      console.log(`[cdk] GitHub OIDC provider already exists; importing ${found}`);
    }
    return found;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[cdk] Could not list IAM OIDC providers (${message}); set INFRA_CDK_OIDC_PROVIDER_ARN to import an existing GitHub IdP`,
    );
    return undefined;
  }
}

/** @intent Merge non-secret values into the committed project/config.json {env} block (shared by identity-numeric-id caching and, historically, the deploy-role-arn writer in infra-provider.ts) */
async function persistProjectConfigValues(
  projectRoot: string,
  env: string,
  values: Record<string, string | undefined>,
): Promise<void> {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (entries.length === 0) return;
  const configPath = path.join(projectRoot, 'project', 'config.json');
  let parsed: Record<string, Record<string, string>>;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, Record<string, string>>;
  } catch {
    return;
  }
  const block = { ...(parsed[env] ?? {}) };
  let changed = false;
  for (const [key, value] of entries) {
    if (block[key] !== value) {
      block[key] = value;
      changed = true;
    }
  }
  if (!changed) return;
  parsed[env] = block;
  await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  console.log(`[cdk] Updated project/config.json ${env}.{${entries.map(([k]) => k).join(', ')}}`);
}

/**
 * @intent Resolve GitHub's immutable numeric owner/repo ids for the correct OIDC subject claim
 * (see subjectFiltersWithNumericIds). Prefers already-cached committed config
 * (INFRA_CDK_GITHUB_ORG_ID/INFRA_CDK_GITHUB_REPO_ID, written by persistGithubOidcOutputs after a
 * successful resolve) over a live GitHub API call, and never throws — falling back to
 * defaultGithubSubjectFilters's name-only format (which will NOT match the real token, but keeps
 * synth from hard-failing on a transient network error) is better than blocking every apply on
 * GitHub API availability.
 */
export async function resolveGithubNumericIdsForSynth(
  options: CreateCdkAppOptions,
): Promise<{ orgId?: string; repoId?: string }> {
  const componentDir = options.projectRoot
    ? path.join(options.projectRoot, 'components', 'infra-cdk')
    : process.cwd();
  const committed = loadCommittedExportDefaults(componentDir, options.env);
  const cachedOrgId = committed.INFRA_CDK_GITHUB_ORG_ID?.trim();
  const cachedRepoId = committed.INFRA_CDK_GITHUB_REPO_ID?.trim();
  if (cachedOrgId && cachedRepoId) {
    return { orgId: cachedOrgId, repoId: cachedRepoId };
  }
  const githubOrg = process.env.INFRA_CDK_GITHUB_ORG?.trim() || committed.INFRA_CDK_GITHUB_ORG?.trim();
  const githubRepo = process.env.INFRA_CDK_GITHUB_REPO?.trim() || committed.INFRA_CDK_GITHUB_REPO?.trim();
  if (!githubOrg || !githubRepo) {
    return {};
  }
  try {
    const ids = await resolveGithubNumericIds(githubOrg, githubRepo);
    console.log(`[cdk] Resolved GitHub numeric ids for ${githubOrg}/${githubRepo}`);
    if (options.projectRoot) {
      await persistProjectConfigValues(options.projectRoot, options.env, {
        INFRA_CDK_GITHUB_ORG_ID: ids.orgId,
        INFRA_CDK_GITHUB_REPO_ID: ids.repoId,
      });
    }
    return { orgId: ids.orgId, repoId: ids.repoId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[cdk] Could not resolve GitHub numeric ids (${message}); OIDC subject claim will use the name-only ` +
        'format, which will not match the real token GitHub issues. Set INFRA_CDK_OIDC_SUBJECT explicitly, or retry apply once GitHub API access is available.',
    );
    return {};
  }
}



