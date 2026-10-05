import fs from 'node:fs';
import path from 'node:path';
import { STRATEGY_REGISTRY } from './strategy-mapping';
import {
  ComposeHostMetadata,
  DeploymentIntent,
  InfraStrategyRequirement,
  PlannedResource,
  PublishedComposeService,
  ResolvedCloudComponent,
  StrategyRegistryEntry,
  StrategyResolutionOptions,
  StrategyResolutionResult,
  StrategyVariantMapping,
} from '../types';
import {
  buildSecretPath,
  defaultManagedSecretName,
  ecrRepositoryName,
  sanitizeSegment,
} from '../utils/path-helpers';
import { DEFAULT_GIT_PASSWORD_SECRET_NAME } from '../utils/root-domain';
import { resolvePortableExtras } from '../release/portable-extras';
import { collectEventsBusPlan } from '../events/events-bus-plan';

const CONFIG_PLACEHOLDER = /^\{\{config\.([a-zA-Z0-9_.]+)\}\}$/;

/** @intent Resolve {{config.key}} in strategy requirements from component thonnas-config (config.<env>.key or config.default.key) */
function resolveConfigPlaceholders(
  projectRoot: string,
  component: string,
  env: string,
  requirement: InfraStrategyRequirement,
): InfraStrategyRequirement {
  let config: Record<string, Record<string, unknown>> | undefined;
  const configPath = path.join(projectRoot, 'components', component, 'thonnas-config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { config?: Record<string, Record<string, unknown>> };
    config = parsed.config;
  } catch {
    return requirement;
  }
  if (!config || typeof config !== 'object') return requirement;

  const envBlock = config[env] ?? config.default ?? {};
  const defaultBlock = config.default ?? {};

  const getByPath = (obj: Record<string, unknown>, keyPath: string): unknown => {
    const parts = keyPath.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  };

  const resolve = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = v.match(CONFIG_PLACEHOLDER);
      if (m) {
        const keyPath = m[1];
        const envVal = getByPath(envBlock as Record<string, unknown>, keyPath);
        if (envVal !== undefined && envVal !== null) return String(envVal);
        const defaultVal = getByPath(defaultBlock as Record<string, unknown>, keyPath);
        if (defaultVal !== undefined && defaultVal !== null) return String(defaultVal);
        return v;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, resolve(val)]));
    return v;
  };

  return resolve(requirement) as InfraStrategyRequirement;
}

interface ResolutionContext {
  env: string;
  rootDomain: string;
  intent: DeploymentIntent;
  /** Git ref for compose-host checkout only. */
  gitTag?: string;
  /** Pre-validated slug for `{deploy-slug}` in hostnames and bucket templates. */
  deploySlug?: string;
  gitPasswordSecretName?: string;
  /** @intent Repo root for reading component thonnas-config (e.g. bucketFromEnv pattern without config resolve) */
  projectRoot?: string;
  /** Sanitized project name for account-unique managed secret defaults. */
  projectName?: string;
}

interface ResourceAccumulator {
  components: ResolvedCloudComponent[];
  resources: Map<string, PlannedResource>;
}

const computeHostname = (intent: DeploymentIntent, env: string, rootDomain: string): string => {
  const pattern =
    intent.environmentDomainPatterns?.[env] ||
    intent.domainPattern ||
    '{env}.{component}.{rootDomain}';
  return pattern
    .replaceAll('{env}', env)
    .replaceAll('{component}', intent.component)
    .replaceAll('{rootDomain}', rootDomain);
};

const pickVariant = (entry: StrategyRegistryEntry | undefined, requirement: InfraStrategyRequirement): StrategyVariantMapping => {
  if (!entry) {
    return {
      construct: requirement.key,
      requires: [],
    };
  }

  if (requirement.engine && entry.variants?.[requirement.engine]) {
    return entry.variants[requirement.engine]!;
  }

  if (entry.default) {
    return entry.default;
  }

  const firstVariant = entry.variants ? Object.values(entry.variants)[0] : undefined;
  if (firstVariant) {
    return firstVariant;
  }

  return {
    construct: requirement.key,
    requires: [],
  };
};

const makeComponentId = (env: string, component: string, strategy: string): string => {
  return `${env}-${component}-${strategy}`.replace(/[^a-zA-Z0-9-]/g, '-');
};

const ensureResource = (acc: ResourceAccumulator, resource: PlannedResource): void => {
  if (!acc.resources.has(resource.id)) {
    acc.resources.set(resource.id, resource);
  }
};

const planEcrRepository = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  projectName?: string,
): string => {
  const repoName = ecrRepositoryName(env, component, projectName);
  // @intent Keep id slash-free so graph keys stay simple while props.name may contain /
  const repoId = `ecr-${repoName.replace(/\//g, '-')}`;
  ensureResource(acc, {
    id: repoId,
    kind: 'ecrRepository',
    env,
    scope: 'service',
    component,
    props: {
      name: repoName,
      uriTemplate: '{cloudAccount}.dkr.ecr.{region}.amazonaws.com/' + repoName,
      lifecycleRules: [{ maxImages: 5 }],
    },
  });
  return repoId;
};

const planLogGroup = (acc: ResourceAccumulator, env: string, component: string): string => {
  // Planner-only id; CloudFormation names use stackPrefix via buildServiceLogGroupName
  const groupName = `/thonnas/${env}/${component}`;
  const logId = `log-${env}-${component}`;
  ensureResource(acc, {
    id: logId,
    kind: 'logGroup',
    env,
    scope: 'service',
    component,
    props: {
      name: groupName,
      retentionDays: 30,
    },
  });
  return logId;
};

const planSecurityGroups = (acc: ResourceAccumulator, env: string, component: string, variant: StrategyVariantMapping): void => {
  if (variant.runtimeType === 'ecs-fargate') {
    ensureResource(acc, {
      id: `sg-${env}-alb-sg`,
      kind: 'securityGroup',
      env,
      scope: 'shared',
      props: {
        name: `${env}-alb-sg`,
        ingress: [{ protocol: 'tcp', port: 80, source: '0.0.0.0/0' }, { protocol: 'tcp', port: 443, source: '0.0.0.0/0' }],
        egress: [{ protocol: '-1', port: -1, target: `sg-${env}-${component}-ecs-sg` }],
      },
    });

    ensureResource(acc, {
      id: `sg-${env}-${component}-ecs-sg`,
      kind: 'securityGroup',
      env,
      scope: 'service',
      component,
      props: {
        name: `${env}-${component}-ecs-sg`,
        ingress: [{ protocol: 'tcp', port: 3000, source: `sg-${env}-alb-sg` }],
        egress: [
          { protocol: 'tcp', port: 5432, target: `sg-${env}-${component}-db-sg` },
          { protocol: '-1', port: -1, target: '0.0.0.0/0' },
        ],
      },
    });
  }

  if (variant.runtimeType === 'ec2-docker') {
    ensureResource(acc, {
      id: `sg-${env}-${component}-ec2-sg`,
      kind: 'securityGroup',
      env,
      scope: 'service',
      component,
      props: {
        name: `${env}-${component}-ec2-sg`,
        ingress: [{ protocol: 'tcp', port: 80, source: '0.0.0.0/0' }],
        egress: [{ protocol: 'tcp', port: 5432, target: `sg-${env}-${component}-db-sg` }],
      },
    });
  }
};

// @intent Resolve {env}, {component}, {rootDomain} so website DNS and fallback buckets are valid
const resolveDomainPattern = (
  pattern: string | undefined,
  env: string,
  rootDomain: string,
  component?: string,
): string | undefined => {
  if (typeof pattern !== 'string' || !pattern.trim()) return pattern;
  let out = pattern.replaceAll('{env}', env).replaceAll('{rootDomain}', rootDomain);
  if (component) {
    out = out.replaceAll('{component}', component);
  }
  return out.trim() || undefined;
};

const planWebsiteBucketResources = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras: Record<string, unknown>,
  rootDomain: string,
): void => {
  const website_domain = resolveDomainPattern(
    extras.website_domain as string | undefined,
    env,
    rootDomain,
    component,
  );
  const hosted_zone_domain = resolveDomainPattern(
    extras.hosted_zone_domain as string | undefined,
    env,
    rootDomain,
    component,
  );
  const bucketId = `s3-website-${env}-${component}`;
  ensureResource(acc, {
    id: bucketId,
    kind: 's3WebsiteBucket',
    env,
    scope: 'service',
    component,
    props: {
      website_domain: website_domain ?? extras.website_domain,
      hosted_zone_domain: hosted_zone_domain ?? extras.hosted_zone_domain,
      ...(typeof extras.bucket === 'string' && extras.bucket.trim()
        ? { bucket: extras.bucket.trim() }
        : {}),
    },
  });
  const aliasId = `route53-alias-${env}-${component}`;
  ensureResource(acc, {
    id: aliasId,
    kind: 'route53AliasForS3',
    env,
    scope: 'service',
    component,
    props: {
      website_domain: website_domain ?? extras.website_domain,
      hosted_zone_domain: hosted_zone_domain ?? extras.hosted_zone_domain,
    },
  });
};

const planArtifactDeployResources = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras: Record<string, unknown>,
): void => {
  const deployId = `s3-artifact-${env}-${component}`;
  ensureResource(acc, {
    id: deployId,
    kind: 's3ArtifactDeployment',
    env,
    scope: 'service',
    component,
    props: {
      artifactPath: extras.artifactPath,
      artifactPaths: extras.artifactPaths,
      bucket: extras.bucket,
      prefix: extras.prefix,
      bucketEnv: extras.bucketEnv,
      prefixEnv: extras.prefixEnv,
      set_latest_link: extras.set_latest_link,
      versionMatch: extras.versionMatch,
    },
  });
};

const planStorageTempUrlResources = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras: Record<string, unknown>,
  rootDomain: string,
): void => {
  const api_domain = resolveDomainPattern(
    extras.api_domain as string | undefined,
    env,
    rootDomain,
    component,
  );
  const hosted_zone_domain = resolveDomainPattern(
    extras.hosted_zone_domain as string | undefined,
    env,
    rootDomain,
    component,
  );
  const bucket = extras.bucket as string | undefined;
  const prefix = (extras.prefix as string) || env;
  const bucket_region =
    typeof extras.bucket_region === 'string' && extras.bucket_region.trim().length > 0
      ? extras.bucket_region.trim()
      : undefined;
  if (!bucket || !api_domain || !hosted_zone_domain) return;
  const handlerPath =
    typeof extras.handlerPath === 'string' && extras.handlerPath.trim().length > 0
      ? extras.handlerPath.trim()
      : 'src/handler.js';
  // @intent Forward extras.env / policyStatements without baking object-key layouts
  const extrasEnv =
    extras.env && typeof extras.env === 'object' && !Array.isArray(extras.env)
      ? extras.env
      : undefined;
  const policyStatements = Array.isArray(extras.policyStatements) ? extras.policyStatements : undefined;
  ensureResource(acc, {
    id: `storage-temp-url-${env}-${component}`,
    kind: 'storageTempUrlApi',
    env,
    scope: 'service',
    component,
    props: {
      bucket,
      prefix,
      api_domain,
      hosted_zone_domain,
      handlerPath,
      ...(bucket_region ? { bucket_region } : {}),
      ...(extrasEnv ? { env: extrasEnv } : {}),
      ...(policyStatements ? { policyStatements } : {}),
    },
  });
};

// @intent Plan origin extras including outputPath; apply does not upload that folder
const planStaticSiteDeployResource = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras: Record<string, unknown>,
  rootDomain: string,
): void => {
  const website_domain = resolveDomainPattern(
    extras.website_domain as string | undefined,
    env,
    rootDomain,
    component,
  );
  const hosted_zone_domain = resolveDomainPattern(
    extras.hosted_zone_domain as string | undefined,
    env,
    rootDomain,
    component,
  );
  const deployId = `s3-static-${env}-${component}`;
  ensureResource(acc, {
    id: deployId,
    kind: 's3StaticSiteDeployment',
    env,
    scope: 'service',
    component,
    props: {
      outputPath: extras.outputPath ?? 'build',
      website_domain: website_domain ?? extras.website_domain,
      hosted_zone_domain: hosted_zone_domain ?? extras.hosted_zone_domain,
      accessControl: extras.accessControl,
      ...(typeof extras.bucket === 'string' && extras.bucket.trim()
        ? { bucket: extras.bucket.trim() }
        : {}),
    },
  });
};

const planComposeHostResources = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  metadata: ComposeHostMetadata,
): void => {
  const sgId = `sg-${env}-${component}-compose-host`;
  ensureResource(acc, {
    id: sgId,
    kind: 'securityGroup',
    env,
    scope: 'service',
    component,
    props: {
      name: `${env}-${component}-compose-host-sg`,
      ingress: metadata.publishedServices.map((service) => ({
        protocol: 'tcp',
        port: service.port,
        source: '0.0.0.0/0',
      })),
      egress: [{ protocol: '-1', port: -1, target: '0.0.0.0/0' }],
    },
  });

  ensureResource(acc, {
    id: `iam-${env}-${component}-compose`,
    kind: 'iamRole',
    env,
    scope: 'service',
    component,
    props: {
      name: `${env}-${component}-compose-host-role`,
      managedPolicies: [
        'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
        'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy',
      ],
      statements: [{ action: ['logs:CreateLogStream', 'logs:PutLogEvents'], resource: '*' }],
    },
  });

  planLogGroup(acc, env, component);

  ensureResource(acc, {
    id: `eip-${env}-${component}`,
    kind: 'elasticIp',
    env,
    scope: 'service',
    component,
    props: {},
  });

  metadata.publishedServices.forEach((service) => {
    const recordId = `dns-${service.hostname.replace(/[^a-z0-9-]/gi, '-')}`;
    ensureResource(acc, {
      id: recordId,
      kind: 'dnsRecord',
      env,
      scope: 'service',
      component,
      props: {
        hostname: service.hostname,
        protocol: service.protocol,
        port: service.port,
      },
    });
  });
};

const planIamRoles = (acc: ResourceAccumulator, env: string, component: string, variant: StrategyVariantMapping): void => {
  if (variant.runtimeType === 'ecs-fargate') {
    ensureResource(acc, {
      id: `iam-${env}-${component}-ecs-exec`,
      kind: 'iamRole',
      env,
      scope: 'service',
      component,
      props: {
        name: `${env}-${component}-ecs-execution-role`,
        managedPolicies: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
        statements: [
          { action: ['logs:CreateLogStream', 'logs:PutLogEvents'], resource: '*' },
          { action: ['ecr:GetAuthorizationToken', 'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer'], resource: '*' },
        ],
      },
    });

    ensureResource(acc, {
      id: `iam-${env}-${component}-ecs-task`,
      kind: 'iamRole',
      env,
      scope: 'service',
      component,
      props: {
        name: `${env}-${component}-ecs-task-role`,
        statements: [{ action: ['ssm:GetParameter', 'secretsmanager:GetSecretValue'], resource: '*' }],
      },
    });
  }

  if (variant.runtimeType === 'ec2-docker') {
    ensureResource(acc, {
      id: `iam-${env}-${component}-ec2`,
      kind: 'iamRole',
      env,
      scope: 'service',
      component,
      props: {
        name: `${env}-${component}-ec2-role`,
        managedPolicies: ['arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly'],
        statements: [{ action: ['logs:CreateLogStream', 'logs:PutLogEvents'], resource: '*' }],
      },
    });
  }
};

// @intent Plan 5432 ingress from peer SG ids only — never 0.0.0.0/0
const planDbSecurityGroup = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras?: Record<string, unknown>,
): void => {
  const extraPeers = Array.isArray(extras?.peerSecurityGroupIds)
    ? extras.peerSecurityGroupIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const sources = [`sg-${env}-${component}-ecs-sg`, ...extraPeers];
  ensureResource(acc, {
    id: `sg-${env}-${component}-db-sg`,
    kind: 'securityGroup',
    env,
    scope: 'service',
    component,
    props: {
      name: `${env}-${component}-db-sg`,
      ingress: sources.map((source) => ({ protocol: 'tcp', port: 5432, source })),
      egress: [],
    },
  });
};

// @intent Plan a portable Secrets Manager name for relational apply
const planDbSecret = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras?: Record<string, unknown>,
  secrets?: Array<{ name: string }>,
  projectName?: string,
): void => {
  const fromExtras = typeof extras?.secretName === 'string' && extras.secretName.trim() ? extras.secretName.trim() : undefined;
  const fromSecrets = secrets?.find((secret) => secret.name.trim())?.name.trim();
  const secretName =
    fromExtras ?? fromSecrets ?? defaultManagedSecretName(projectName, env, component, 'postgres');
  ensureResource(acc, {
    id: `secret-${env}-${component}-db`,
    kind: 'dbSecret',
    env,
    scope: 'service',
    component,
    props: {
      secretName,
      path: planSecretRequirement(env, component, secretName),
    },
  });
};

// @intent Plan 27017 ingress from peer SG ids only — never a world-open CIDR
const planDocDbSecurityGroup = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras?: Record<string, unknown>,
): void => {
  const extraPeers = Array.isArray(extras?.peerSecurityGroupIds)
    ? extras.peerSecurityGroupIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const sources = [`sg-${env}-${component}-ecs-sg`, ...extraPeers];
  ensureResource(acc, {
    id: `sg-${env}-${component}-docdb-sg`,
    kind: 'securityGroup',
    env,
    scope: 'service',
    component,
    props: {
      name: `${env}-${component}-docdb-sg`,
      ingress: sources.map((source) => ({ protocol: 'tcp', port: 27017, source })),
      egress: [],
    },
  });
};

// @intent Plan a portable Secrets Manager name for document apply
const planDocDbSecret = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras?: Record<string, unknown>,
  secrets?: Array<{ name: string }>,
  projectName?: string,
): void => {
  const fromExtras = typeof extras?.secretName === 'string' && extras.secretName.trim() ? extras.secretName.trim() : undefined;
  const fromSecrets = secrets?.find((secret) => secret.name.trim())?.name.trim();
  const secretName =
    fromExtras ?? fromSecrets ?? defaultManagedSecretName(projectName, env, component, 'docdb');
  ensureResource(acc, {
    id: `secret-${env}-${component}-docdb`,
    kind: 'dbSecret',
    env,
    scope: 'service',
    component,
    props: {
      secretName,
      path: planSecretRequirement(env, component, secretName),
    },
  });
};

// @intent Plan 6379 ingress from peer SG ids only — never a world-open CIDR
const planCacheSecurityGroup = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras?: Record<string, unknown>,
): void => {
  const extraPeers = Array.isArray(extras?.peerSecurityGroupIds)
    ? extras.peerSecurityGroupIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const sources = [`sg-${env}-${component}-ecs-sg`, ...extraPeers];
  ensureResource(acc, {
    id: `sg-${env}-${component}-cache-sg`,
    kind: 'securityGroup',
    env,
    scope: 'service',
    component,
    props: {
      name: `${env}-${component}-cache-sg`,
      ingress: sources.map((source) => ({ protocol: 'tcp', port: 6379, source })),
      egress: [],
    },
  });
};

// @intent Plan a portable Secrets Manager name for cache apply
const planCacheSecret = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras?: Record<string, unknown>,
  secrets?: Array<{ name: string }>,
  projectName?: string,
): void => {
  const fromExtras = typeof extras?.secretName === 'string' && extras.secretName.trim() ? extras.secretName.trim() : undefined;
  const fromSecrets = secrets?.find((secret) => secret.name.trim())?.name.trim();
  const secretName =
    fromExtras ?? fromSecrets ?? defaultManagedSecretName(projectName, env, component, 'redis');
  ensureResource(acc, {
    id: `secret-${env}-${component}-cache`,
    kind: 'dbSecret',
    env,
    scope: 'service',
    component,
    props: {
      secretName,
      path: planSecretRequirement(env, component, secretName),
    },
  });
};

const planSecretRequirement = (env: string, component: string, secretName: string): string => {
  return buildSecretPath(env, component, secretName);
};

// @intent Pre-validated deploy slug from CLI; omit in prod hostnames; omit when empty or equals env
const computeDeploySlugPrefix = (env: string, deploySlug: string | null | undefined): string => {
  const lowerEnv = env.toLowerCase();
  if (lowerEnv === 'prod' || lowerEnv === 'production') return '';
  if (!deploySlug || !deploySlug.trim()) return '';
  const s = deploySlug.trim().toLowerCase();
  if (s === lowerEnv) return '';
  return s;
};

const resolveHostnamePattern = (
  pattern: string,
  env: string,
  rootDomain: string,
  component: string,
  serviceName: string,
  deploySlug?: string | null,
): string => {
  const slugPrefix = computeDeploySlugPrefix(env, deploySlug ?? null);
  return pattern
    .replaceAll('{deploy-slug}', slugPrefix)
    .replaceAll('{env}', env)
    .replaceAll('{component}', component)
    .replaceAll('{rootDomain}', rootDomain)
    .replaceAll('{service}', serviceName)
    .replace(/\.\.+/g, '.')
    .replace(/^\.+/, '');
};

// @intent Map rootDomain to a single S3-safe segment (dots -> hyphens, lowercase) for use inside bucket names
const rootDomainToBucketSegment = (rootDomain: string): string =>
  rootDomain
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/\./g, '-')
    .replace(/[-.]{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

const componentToBucketSegment = (component: string): string =>
  component
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

// @intent Resolve {env}, {rootDomain}, {deploy-slug}, {component}, {service} in infra.storage bucket templates; enforce S3 naming rules
const resolveBucketNameTemplate = (
  template: string,
  env: string,
  rootDomain: string,
  component: string,
  deploySlug?: string | null,
): string => {
  const slugPrefix = computeDeploySlugPrefix(env, deploySlug ?? null);
  const rootSeg = rootDomainToBucketSegment(rootDomain);
  const compSeg = componentToBucketSegment(component);
  let s = template
    .replaceAll('{deploy-slug}', slugPrefix)
    .replaceAll('{env}', env)
    .replaceAll('{rootDomain}', rootSeg)
    .replaceAll('{component}', compSeg)
    .replaceAll('{service}', compSeg);
  // @intent Post-replacement: empty {deploy-slug} must not yield "--" (e.g. svc--beta)
  s = s.replace(/-{2,}/g, '-');
  s = s.toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/[-.]{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  s = s.replace(/-{2,}/g, '-');
  if (s.length > 63) {
    s = s.slice(0, 63).replace(/[-.]+$/g, '');
  }
  return s;
};

// @intent Read default pattern for an internal config key from component thonnas-config (used when bucketFromEnv has no env override)
const readInternalConfigDefaultPattern = (
  projectRoot: string,
  component: string,
  settingName: string,
): string => {
  const configPath = path.join(projectRoot, 'components', component, 'thonnas-config.json');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(content) as { internal?: Array<{ name?: string; default?: unknown }> };
    const entry = parsed.internal?.find((e) => e.name === settingName);
    if (entry?.default && typeof entry.default === 'string' && entry.default.trim()) {
      return entry.default.trim();
    }
  } catch {
    /* fall through */
  }
  return `${component}-{deploy-slug}-{env}`;
};

const planStorageBucketResources = (
  acc: ResourceAccumulator,
  env: string,
  component: string,
  extras: Record<string, unknown>,
  rootDomain: string,
  deploySlug?: string | null,
  projectRoot?: string,
): void => {
  const bucketFromEnv =
    typeof extras.bucketFromEnv === 'string' && extras.bucketFromEnv.trim()
      ? extras.bucketFromEnv.trim()
      : undefined;
  const raw = typeof extras.bucket === 'string' && extras.bucket.trim() ? extras.bucket.trim() : undefined;

  if (!raw && !bucketFromEnv) return;

  let bucketName: string | undefined;

  if (raw) {
    // @intent Support {env.VAR_NAME} syntax to read from process.env (legacy; requires var set before infra plan)
    let bucketValue = raw;
    const envVarMatch = raw.match(/^\{env\.([A-Z_][A-Z0-9_]*)\}$/);
    if (envVarMatch) {
      const envVarName = envVarMatch[1];
      const envValue = process.env[envVarName];
      if (envValue && envValue.trim()) {
        bucketValue = envValue.trim();
      } else {
        return;
      }
    }
    bucketName = resolveBucketNameTemplate(bucketValue, env, rootDomain, component, deploySlug);
  } else if (bucketFromEnv) {
    // @intent bucketFromEnv: name of runtime env var (set by config resolve / build); not required during infra plan
    const envOverride = process.env[bucketFromEnv]?.trim();
    if (envOverride) {
      bucketName = envOverride;
    } else if (projectRoot) {
      const pattern = readInternalConfigDefaultPattern(projectRoot, component, bucketFromEnv);
      bucketName = resolveBucketNameTemplate(pattern, env, rootDomain, component, deploySlug);
    } else {
      return;
    }
  }

  if (!bucketName) return;
  const bucketId = `s3-storage-${env}-${component}`;
  ensureResource(acc, {
    id: bucketId,
    kind: 's3StorageBucket',
    env,
    scope: 'service',
    component,
    props: { bucket: bucketName },
  });
};

const resolveComposeServices = (
  services: unknown,
  env: string,
  rootDomain: string,
  component: string,
  deploySlug?: string | null,
): PublishedComposeService[] => {
  if (!Array.isArray(services)) {
    return [
      {
        name: component,
        port: 80,
        protocol: 'http',
        hostname: resolveHostnamePattern(
          '{env}.{component}.{rootDomain}',
          env,
          rootDomain,
          component,
          component,
          deploySlug,
        ),
      },
    ];
  }

  return services.map((svc) => {
    const name = typeof svc?.name === 'string' ? svc.name : component;
    const port = typeof svc?.port === 'number' ? svc.port : 80;
    const protocol = svc?.protocol === 'https' ? 'https' : 'http';
    const pattern =
      typeof svc?.hostnamePattern === 'string' ? svc.hostnamePattern : '{env}.{service}.{rootDomain}';
    return {
      name,
      port,
      protocol,
      hostname: resolveHostnamePattern(pattern, env, rootDomain, component, name, deploySlug),
    };
  });
};

// @intent Read compose-host config from thonnas-config (component .env.{env}) or strategy extras. Values are read at CDK
// deploy time on the machine running infra:apply; they are baked into EC2 user-data (REPO_URL, GIT_CLONE_USERNAME, etc.),
// so the instance does not need these env vars at runtime—they are embedded in the bootstrap script.
const buildComposeMetadata = (context: ResolutionContext, requirement: InfraStrategyRequirement): ComposeHostMetadata => {
  const extras = requirement.extras ?? {};
  const gitRepositoryUrl =
    process.env.THONNAS_COMPOSE_GIT_REPO_URL ??
    process.env.COMPOSE_GIT_REPO_URL ??
    (typeof extras.gitRepositoryUrl === 'string' ? extras.gitRepositoryUrl : undefined);
  if (!gitRepositoryUrl?.trim()) {
    throw new Error(
      'Compose-host git repository URL is required. Set THONNAS_COMPOSE_GIT_REPO_URL or extras.gitRepositoryUrl.',
    );
  }
  const branch =
    process.env.THONNAS_COMPOSE_GIT_BRANCH ??
    process.env.COMPOSE_GIT_BRANCH ??
    (typeof extras.branch === 'string' ? extras.branch : undefined) ??
    (context.gitTag && context.gitTag.length > 0 ? context.gitTag : 'main');
  const tag = context.gitTag;
  const composeFile =
    typeof extras.composeFile === 'string'
      ? extras.composeFile
      : 'components/infra-docker/docker-compose.yml';
  const workingDirectory =
    typeof extras.workingDirectory === 'string' && extras.workingDirectory.trim().length > 0
      ? extras.workingDirectory
      : '/opt/app';
  const publishedServices = resolveComposeServices(
    extras.publishedServices,
    context.env,
    context.rootDomain,
    context.intent.component,
    context.deploySlug,
  );
  const gitPasswordSecretName =
    process.env.THONNAS_COMPOSE_GIT_PASSWORD_SECRET_NAME ??
    process.env.COMPOSE_GIT_PASSWORD_SECRET_NAME ??
    (typeof extras.gitPasswordSecretName === 'string' && extras.gitPasswordSecretName.trim().length > 0
      ? extras.gitPasswordSecretName
      : undefined) ??
    context.gitPasswordSecretName ??
    DEFAULT_GIT_PASSWORD_SECRET_NAME;
  const gitUsername =
    process.env.THONNAS_COMPOSE_GIT_USERNAME ??
    process.env.COMPOSE_GIT_USERNAME ??
    (typeof extras.gitUsername === 'string' && extras.gitUsername.trim().length > 0 ? extras.gitUsername.trim() : undefined);

  const certificateArn =
    process.env.THONNAS_COMPOSE_CERTIFICATE_ARN ??
    process.env.COMPOSE_CERTIFICATE_ARN ??
    (typeof extras.certificateArn === 'string' && extras.certificateArn.trim().length > 0
      ? extras.certificateArn.trim()
      : undefined);

  // @intent Read stack scopes from strategy requirement (at strategy level, not in extras; defaults to "env" for backward compatibility)
  const scoped = requirement as {
    networkingScope?: 'env' | 'git-tag' | 'account';
    wiringScope?: 'env' | 'git-tag' | 'account';
    composeHostScope?: 'env' | 'git-tag' | 'account';
  };
  const networkingScope = scoped.networkingScope ?? 'env';
  const wiringScope = scoped.wiringScope ?? 'env';
  const composeHostScope = scoped.composeHostScope ?? 'env';

  return {
    gitRepositoryUrl,
    branch,
    tag,
    composeFile,
    workingDirectory,
    publishedServices,
    hostedZoneId: typeof extras.hostedZoneId === 'string' ? extras.hostedZoneId : undefined,
    hostedZoneName: typeof extras.hostedZoneName === 'string' ? extras.hostedZoneName : undefined,
    rootDomain: context.rootDomain,
    gitPasswordSecretName,
    networkingScope,
    wiringScope,
    composeHostScope,
    gitUsername,
    certificateArn,
  };
};

const resolveStrategy = (
  context: ResolutionContext,
  strategyName: string,
  requirement: InfraStrategyRequirement,
  acc: ResourceAccumulator,
): void => {
  // @intent LocalStack is the emulator; CDK does not synthesize a stack for it
  if (requirement.key === 'infra.aws.localstack') {
    return;
  }

  if (requirement.key === 'infra.bootstrap') {
    return;
  }

  // @intent Plan GitHub OIDC from infra.identity.oidc instead of a runtime special case
  if (requirement.key === 'infra.identity.oidc') {
    const extras = (requirement.extras ?? {}) as Record<string, unknown>;
    const issuer = typeof extras.issuer === 'string' ? extras.issuer : 'github';
    ensureResource(acc, {
      id: `github-oidc-${context.env}`,
      kind: 'githubOidcIdentity',
      env: context.env,
      scope: 'shared',
      component: context.intent.component,
      props: { issuer },
    });
    return;
  }

  // @intent Plan SNS+SQS from aggregated thonnas-events.json claims
  if (requirement.key === 'comms.events.pub-sub.sns') {
    const plan = collectEventsBusPlan(context.projectRoot, context.env, context.projectName);
    ensureResource(acc, {
      id: `sns-sqs-event-bus-${context.env}`,
      kind: 'snsSqsEventBus',
      env: context.env,
      scope: 'shared',
      component: context.intent.component,
      props: {
        topicName: plan.topicName,
        queues: plan.queues,
      },
    });
    return;
  }

  const registryEntry = STRATEGY_REGISTRY[requirement.key];
  const variant = pickVariant(registryEntry, requirement);
  const hostname = computeHostname(context.intent, context.env, context.rootDomain);
  const composeMetadata =
    requirement.key === 'infra.container.compose-host' ? buildComposeMetadata(context, requirement) : undefined;

  const runtimeType = variant.runtimeType;
  // @intent Artifact/website/static components have no runtimeType; use 'direct' so they do not trigger ALB/EcsShared
  const routing: 'alb' | 'direct' =
    runtimeType === 'ec2-docker' || runtimeType === 'compose-host' || !runtimeType ? 'direct' : 'alb';

  const resolved: ResolvedCloudComponent = {
    id: makeComponentId(context.env, context.intent.component, strategyName),
    component: context.intent.component,
    env: context.env,
    strategy: strategyName,
    construct: variant.construct,
    scope: variant.scope ?? 'service',
    requires: variant.requires,
    metadata: {
      ports: requirement.ports,
      exposed: requirement.exposed,
      hostname,
      runtimeType,
      targetGroupPort: requirement.ports?.[0] ?? 80,
      routing,
      compose: composeMetadata,
      protocols: Array.isArray((requirement.extras as { protocols?: string[] } | undefined)?.protocols)
        ? ((requirement.extras as { protocols: string[] }).protocols)
        : undefined,
      certificateArn:
        typeof (requirement.extras as { certificateArn?: string } | undefined)?.certificateArn === 'string'
          ? (requirement.extras as { certificateArn: string }).certificateArn
          : undefined,
      extras: resolvePortableExtras({
        env: context.env,
        extras: {
          ...(requirement.extras ?? {}),
          // @intent Persist strategy identity so observe family detection is not slot-name brittle
          strategyKey: requirement.key,
          ...(requirement.engine ? { engine: requirement.engine } : {}),
        },
      }),
      engine: requirement.engine,
      secrets: requirement.secrets?.map((secret) => ({ name: secret.name })),
    },
  };

  acc.components.push(resolved);

  if (runtimeType && runtimeType !== 'compose-host') {
    planEcrRepository(acc, context.env, context.intent.component, context.projectName);
    planLogGroup(acc, context.env, context.intent.component);
    planSecurityGroups(acc, context.env, context.intent.component, variant);
    planIamRoles(acc, context.env, context.intent.component, variant);
  }

  if (runtimeType === 'compose-host' && composeMetadata) {
    planComposeHostResources(acc, context.env, context.intent.component, composeMetadata);
  }

  if (requirement.key === 'infra.db.relational') {
    planDbSecurityGroup(acc, context.env, context.intent.component, requirement.extras);
    planDbSecret(
      acc,
      context.env,
      context.intent.component,
      requirement.extras,
      requirement.secrets,
      context.projectName,
    );
  }
  if (requirement.key === 'infra.db.document') {
    planDocDbSecurityGroup(acc, context.env, context.intent.component, requirement.extras);
    planDocDbSecret(
      acc,
      context.env,
      context.intent.component,
      requirement.extras,
      requirement.secrets,
      context.projectName,
    );
  }
  if (requirement.key === 'infra.cache.keyvalue') {
    planCacheSecurityGroup(acc, context.env, context.intent.component, requirement.extras);
    planCacheSecret(
      acc,
      context.env,
      context.intent.component,
      requirement.extras,
      requirement.secrets,
      context.projectName,
    );
  }

  if (requirement.key === 'infra.artifact.website-bucket' && requirement.extras) {
    planWebsiteBucketResources(
      acc,
      context.env,
      context.intent.component,
      requirement.extras as Record<string, unknown>,
      context.rootDomain,
    );
  }

  if (requirement.key === 'infra.website.static' && requirement.extras) {
    const extras = requirement.extras as Record<string, unknown>;
    planWebsiteBucketResources(acc, context.env, context.intent.component, extras, context.rootDomain);
    planStaticSiteDeployResource(acc, context.env, context.intent.component, extras, context.rootDomain);
  }

  if (requirement.key === 'infra.artifact.deploy' && requirement.extras) {
    planArtifactDeployResources(acc, context.env, context.intent.component, requirement.extras as Record<string, unknown>);
  }

  // @intent Plan signed-URL API resources when strategy infra.api.storage-temp-url is declared
  if (requirement.key === 'infra.api.storage-temp-url' && requirement.extras) {
    planStorageTempUrlResources(
      acc,
      context.env,
      context.intent.component,
      requirement.extras as Record<string, unknown>,
      context.rootDomain,
    );
  }

  // @intent infra.storage: bucket literal/template, or bucketFromEnv (resolved at plan time from pattern + deploy-slug)
  if (requirement.key === 'infra.storage') {
    const opts = (requirement.extras ?? requirement) as Record<string, unknown>;
    const hasBucket = typeof opts.bucket === 'string';
    const hasBucketFromEnv =
      typeof opts.bucketFromEnv === 'string' && opts.bucketFromEnv.trim().length > 0;
    if (opts && (hasBucket || hasBucketFromEnv)) {
      planStorageBucketResources(
        acc,
        context.env,
        context.intent.component,
        opts,
        context.rootDomain,
        context.deploySlug,
        context.projectRoot,
      );
    }
  }

  requirement.secrets?.forEach((secret) => {
    planSecretRequirement(context.env, context.intent.component, secret.name);
  });
};

const resolveIntent = (
  intent: DeploymentIntent,
  options: StrategyResolutionOptions,
  acc: ResourceAccumulator,
): void => {
  const envStrategies = intent.environments[options.env] ?? intent.strategies;
  const context: ResolutionContext = {
    env: sanitizeSegment(options.env) || options.env,
    rootDomain: options.rootDomain,
    intent,
    gitTag: options.gitTag,
    deploySlug: options.deploySlug,
    gitPasswordSecretName: options.gitPasswordSecretName,
    projectRoot: options.projectRoot,
    projectName: options.projectName,
  };

  Object.entries(envStrategies).forEach(([strategyName, requirement]) => {
    const resolvedRequirement =
      options.projectRoot ?
        resolveConfigPlaceholders(options.projectRoot, context.intent.component, context.env, requirement)
      : requirement;
    const key = resolvedRequirement.key ?? strategyName;
    // @intent Honor CLI --strategies so apply/destroy do not synthesize unrelated stacks
    if (options.strategyFilter?.length) {
      if (!options.strategyFilter.includes(key) && !options.strategyFilter.includes(strategyName)) {
        return;
      }
    }
    resolveStrategy(context, strategyName, resolvedRequirement, acc);
  });
};

export const resolveStrategies = (
  intents: DeploymentIntent[],
  options: StrategyResolutionOptions,
): StrategyResolutionResult => {
  const acc: ResourceAccumulator = {
    components: [],
    resources: new Map<string, PlannedResource>(),
  };

  intents.forEach((intent) => resolveIntent(intent, options, acc));

  return {
    components: acc.components,
    resources: Array.from(acc.resources.values()),
  };
};




