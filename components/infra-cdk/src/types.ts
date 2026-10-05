import { z } from 'zod';

// @intent Define schema + types for infra strategy declarations
export const scalingSchema = z
  .object({
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  })
  .refine(
    (value) => {
      if (!value?.min || !value?.max) return true;
      return value.min <= value.max;
    },
    { message: 'scaling.min must be <= scaling.max' },
  );

const secretDescriptorSchema = z.object({
  name: z.string().min(1, 'Secret name is required'),
  description: z.string().optional(),
  generator: z.enum(['random32']).default('random32'),
});

const endpointSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  protocol: z.string().optional(),
  role: z.string().optional(),
  tags: z.array(z.string()).optional(),
  url: z.string().optional(),
});

// @intent Accept endpoints as array or role-keyed object (endpoints.internal.endpoints.primary, etc.)
const endpointsValueSchema = z.union([
  z.array(endpointSchema),
  z.record(z.string(), endpointSchema),
]);

const endpointSetSchema = z.object({
  hostnamePattern: z.string().optional(),
  default: endpointSchema.optional(),
  endpoints: endpointsValueSchema.optional(),
});

const componentEndpointsSchema = z
  .object({
    internal: endpointSetSchema.optional(),
    external: endpointSetSchema.optional(),
  })
  .optional();

const derivationDescriptorSchema = z.object({
  name: z.string().min(1, 'Derivation name is required'),
  type: z.enum(['config', 'secret']).optional(),
  description: z.string().optional(),
  path: z.string().optional(),
  templateType: z.enum(['string', 'json']).optional(),
  source: z.string().optional(),
  sourcePath: z.string().optional(),
  resolverModule: z.string().optional(),
  options: z.record(z.any()).optional(),
  secretSourceType: z.enum(['generated', 'user-provided']).optional(),
});

const strategyRequirementSchema = z
  .object({
    key: z.string().min(1, 'Strategy key is required'),
    ports: z.array(z.number().int().positive()).optional(),
    exposed: z.boolean().optional(),
    scaling: scalingSchema.optional(),
    engine: z.string().optional(),
    extras: z.record(z.any()).optional(),
    secrets: z.array(secretDescriptorSchema).optional(),
  })
  .passthrough(); // @intent Allow strategy-specific fields like bucket for infra.storage

const strategyOverrideSchema = strategyRequirementSchema.deepPartial();

export const definitionBlockSchema = z.object({
  domain: z.string().optional(),
  strategies: z.record(strategyRequirementSchema).optional(),
  endpoints: componentEndpointsSchema.optional(),
  derivations: z.array(derivationDescriptorSchema).optional(),
});

export const environmentBlockSchema = z.object({
  domain: z.string().optional(),
  strategies: z.record(strategyOverrideSchema).optional(),
  endpoints: componentEndpointsSchema.optional(),
  derivations: z.array(derivationDescriptorSchema).optional(),
});

export const deploymentSpecSchema = z
  .object({
    thonnasInfraVersion: z.number().int().min(1).default(1),
    default: definitionBlockSchema,
  })
  .passthrough();

export type SecretDescriptor = z.infer<typeof secretDescriptorSchema>;
export type InfraStrategyRequirement = z.infer<typeof strategyRequirementSchema>;
export type InfraStrategyOverride = z.infer<typeof strategyOverrideSchema>;
export type EnvironmentOverrides = Record<string, InfraStrategyOverride>;
export type EndpointDescriptor = z.infer<typeof endpointSchema>;
export type EndpointSet = z.infer<typeof endpointSetSchema>;
export type ComponentEndpoints = z.infer<typeof componentEndpointsSchema>;
export type DerivationDescriptor = z.infer<typeof derivationDescriptorSchema>;
export type DefinitionBlock = z.infer<typeof definitionBlockSchema>;
export type EnvironmentBlock = z.infer<typeof environmentBlockSchema>;

export interface SecretRequest {
  name: string;
  scope: 'component' | 'strategy';
  strategy?: string;
  description?: string;
  generator: 'random32';
}

export interface DeploymentIntent {
  component: string;
  componentPath: string;
  thonnasInfraVersion: number;
  domainPattern: string;
  /** Per-env domain templates from thonnas-infra.json env blocks (e.g. staging.domain). */
  environmentDomainPatterns?: Record<string, string>;
  strategies: Record<string, InfraStrategyRequirement>;
  environments: Record<string, Record<string, InfraStrategyRequirement>>;
  requiredSecrets: SecretRequest[];
  endpoints?: ComponentEndpoints;
  environmentEndpoints?: Record<string, ComponentEndpoints | undefined>;
  derivations?: DerivationDescriptor[];
  environmentDerivations?: Record<string, DerivationDescriptor[] | undefined>;
}

export interface CollectorOptions {
  projectRoot: string;
  env: string;
  rootDomain?: string;
  dryRun?: boolean;
  /** App component keys from `--target-component` (not the infra provider key). */
  targetComponents?: string[];
}

export type GraphNodeScope = 'shared' | 'service';

export interface GraphNode {
  id: string;
  type: string;
  scope: GraphNodeScope;
  props: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  reason: string;
}

export interface DependencyGraph {
  environment: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type StrategyRuntimeType = 'ecs-fargate' | 'ec2-docker' | 'compose-host';

export interface PublishedComposeService {
  name: string;
  port: number;
  protocol: 'http' | 'https';
  hostname: string;
}

export interface ComposeHostMetadata {
  gitRepositoryUrl: string;
  branch: string;
  tag?: string;
  composeFile: string;
  workingDirectory: string;
  publishedServices: PublishedComposeService[];
  hostedZoneId?: string;
  hostedZoneName?: string;
  rootDomain?: string;
  gitPasswordSecretName?: string;
  gitUsername?: string;
  /** ACM certificate ARN for ALB HTTPS (443); when set, ALB terminates TLS and forwards to EC2:80 */
  certificateArn?: string;
  /** Stack scoping: "env" = shared per env, "git-tag" = isolated per branch, "account" = shared across account */
  networkingScope?: 'env' | 'git-tag' | 'account';
  /** Stack scoping: "env" = shared per env, "git-tag" = isolated per branch, "account" = shared across account */
  wiringScope?: 'env' | 'git-tag' | 'account';
  /** Stack scoping: "env" = shared per env, "git-tag" = isolated per branch, "account" = shared across account */
  composeHostScope?: 'env' | 'git-tag' | 'account';
}

export interface StrategyVariantMapping {
  construct: string;
  requires: string[];
  runtimeType?: StrategyRuntimeType;
  scope?: 'shared' | 'service';
}

export interface StrategyRegistryEntry {
  default?: StrategyVariantMapping;
  variants?: Record<string, StrategyVariantMapping>;
}

export type StrategyRegistry = Record<string, StrategyRegistryEntry>;

export interface ResolvedCloudComponent {
  id: string;
  component: string;
  env: string;
  strategy: string;
  construct: string;
  scope: 'shared' | 'service';
  requires: string[];
  metadata: {
    ports?: number[];
    exposed?: boolean;
    hostname?: string;
    runtimeType?: StrategyRuntimeType;
    targetGroupPort?: number;
    routing?: 'alb' | 'direct';
    scaling?: {
      min?: number;
      max?: number;
    };
    compose?: ComposeHostMetadata;
    protocols?: string[];
    certificateArn?: string;
    /** Portable extras from the strategy slot (secretName, peerSecurityGroupIds, engine). */
    extras?: Record<string, unknown>;
    engine?: string;
    secrets?: Array<{ name: string }>;
  };
}

export type PlannedResourceKind =
  | 'ecrRepository'
  | 'securityGroup'
  | 'iamRole'
  | 'logGroup'
  | 'dnsRecord'
  | 'elasticIp'
  | 's3WebsiteBucket'
  | 's3StorageBucket'
  | 'route53AliasForS3'
  | 's3ArtifactDeployment'
  | 's3StaticSiteDeployment'
  | 'storageTempUrlApi'
  | 'cloudfrontDistribution'
  | 'route53Record'
  | 'dbSecret'
  | 'snsSqsEventBus'
  | 'githubOidcIdentity';

export interface PlannedResource {
  id: string;
  kind: PlannedResourceKind;
  env: string;
  scope: 'shared' | 'service';
  component?: string;
  props: Record<string, unknown>;
}

export interface StrategyResolutionOptions {
  env: string;
  rootDomain: string;
  /** Project root so strategy requirements can resolve {{config.key}} from component thonnas-config (config.<env>.key or config.default.key) */
  projectRoot?: string;
  /** Git ref for compose-host checkout only (not used for hostname/bucket templates). */
  gitTag?: string;
  /** Pre-validated deploy slug from `thonnas infra` / `config resolve --deploy-slug` for `{deploy-slug}` in host and bucket patterns. */
  deploySlug?: string;
  gitPasswordSecretName?: string;
  /** CLI `--strategies` keys; omit a requirement when neither key nor slot name matches. */
  strategyFilter?: string[];
  /** Sanitized project name so planned dbSecret names match DocDbStack/RdsStack defaults. */
  projectName?: string;
}

export interface StrategyResolutionResult {
  components: ResolvedCloudComponent[];
  resources: PlannedResource[];
}




