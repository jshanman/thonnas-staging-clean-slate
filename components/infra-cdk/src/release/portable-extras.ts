// @intent List portable extra keys without vendor product names

export const PORTABLE_EXTRA_KEYS = [
  'capacity.cpu',
  'capacity.memory',
  'scaling.min',
  'scaling.max',
  'scaling.metric',
  'health.path',
  'health.intervalSeconds',
  'health.graceSeconds',
  'deploy.rolling.minHealthyPercent',
  'deploy.rolling.maxHealthyPercent',
  'deploy.circuitBreaker',
  'deploy.wait',
  'deploy.waitSeconds',
  'release.env',
  'drain.timeoutSeconds',
  'logs.retentionDays',
  'protect.fromDelete',
  'ha.multiAz',
  'backup.retentionDays',
] as const;

export type PortableExtraKey = (typeof PORTABLE_EXTRA_KEYS)[number];

export const CAPACITIES = ['xs', 's', 'm', 'l', 'xl'] as const;
export const RELIABILITIES = ['dev', 'standard', 'hardened'] as const;
/** apply = keep apply-time task env; resolve = overlay .env.{env} from config resolve */
export const RELEASE_ENVS = ['apply', 'resolve'] as const;

export type Capacity = (typeof CAPACITIES)[number];
export type Reliability = (typeof RELIABILITIES)[number];
export type ReleaseEnv = (typeof RELEASE_ENVS)[number];

/** One Fargate size table — valid cpu/memory pairs only. Do not size Lambda. */
export const CAPACITY_TABLE: Record<Capacity, { cpu: number; memory: number }> = {
  xs: { cpu: 256, memory: 512 },
  s: { cpu: 512, memory: 1024 },
  m: { cpu: 1024, memory: 2048 },
  l: { cpu: 2048, memory: 4096 },
  xl: { cpu: 4096, memory: 8192 },
};

export const RELIABILITY_TABLE: Record<
  Reliability,
  {
    scalingMin: number;
    protectFromDelete: boolean;
    multiAz: boolean;
    backupRetentionDays: number;
    logsRetentionDays: number;
  }
> = {
  dev: { scalingMin: 1, protectFromDelete: false, multiAz: false, backupRetentionDays: 1, logsRetentionDays: 7 },
  standard: { scalingMin: 2, protectFromDelete: true, multiAz: true, backupRetentionDays: 7, logsRetentionDays: 30 },
  hardened: { scalingMin: 2, protectFromDelete: true, multiAz: true, backupRetentionDays: 14, logsRetentionDays: 90 },
};

const VENDOR_TOKENS = /^(rds|elasticache|fargate|cloudfront|alb|documentdb)$/i;

export function extraKeyHasVendorToken(key: string): boolean {
  return key.split('.').some((part) => VENDOR_TOKENS.test(part));
}

// @intent Staging/production default s+standard; everything else xs+dev (CI)
export function defaultCapacityReliability(env: string): { capacity: Capacity; reliability: Reliability } {
  const lower = env.toLowerCase();
  if (lower === 'staging' || lower === 'prod' || lower === 'production') {
    return { capacity: 's', reliability: 'standard' };
  }
  return { capacity: 'xs', reliability: 'dev' };
}

const readEnum = <T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unknown ${field} "${String(value)}". Use ${allowed.join('|')}.`);
};

export function extraNumber(extras: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = extras?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

// @intent apply = keep apply-time hosts (SM / DocumentToEcs / RelationalToEcs); still fill thonnas-secrets.json at release
export function extraReleaseEnv(extras?: Record<string, unknown>): ReleaseEnv {
  return readEnum(extras?.['release.env'], RELEASE_ENVS, 'release.env') ?? 'resolve';
}

export function shouldMergeResolvedHostEnv(extras?: Record<string, unknown>): boolean {
  return extraReleaseEnv(extras) === 'resolve';
}

/** AWS services-stable default used when package extras omit a longer grace window. */
export const DEFAULT_STABLE_WAIT_SECONDS = 480;
/** Image pull + task start happen before healthCheckGracePeriodSeconds begins. */
const IMAGE_PULL_BUFFER_SECONDS = 180;
/** ALB HealthyThresholdCount default (consecutive successes after grace). */
const ALB_HEALTHY_THRESHOLD = 2;

// @intent Waiter must outlive grace + ALB healthy threshold + TG drain + pull (AWS services-stable)
export function stableWaitSeconds(input: { env: string; extras?: Record<string, unknown> }): number {
  const extras = resolvePortableExtras(input);
  const override = extraNumber(extras, 'deploy.waitSeconds');
  if (override !== undefined) return Math.max(15, Math.floor(override));
  const grace = extraNumber(extras, 'health.graceSeconds') ?? 60;
  const drain = extraNumber(extras, 'drain.timeoutSeconds') ?? 60;
  const interval = extraNumber(extras, 'health.intervalSeconds') ?? 30;
  const derived = grace + drain + interval * ALB_HEALTHY_THRESHOLD + IMAGE_PULL_BUFFER_SECONDS;
  return Math.max(DEFAULT_STABLE_WAIT_SECONDS, derived);
}

export function extraBoolean(extras: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = extras?.[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

const ORIGINAL_SCALING_MIN = 'thonnas.originalScalingMin';

// @intent Fingerprint a prior resolve so profile scaling.min is not "original"
function extrasAlreadyExpanded(extras: Record<string, unknown>): boolean {
  return extraNumber(extras, 'capacity.cpu') !== undefined && extraNumber(extras, 'logs.retentionDays') !== undefined;
}

// @intent Expand capacity+reliability then let package extras win
export function resolvePortableExtras(input: { env: string; extras?: Record<string, unknown> }): Record<string, unknown> {
  const extras = { ...(input.extras ?? {}) };
  const packageSetMin =
    extras[ORIGINAL_SCALING_MIN] === true ||
    (extraNumber(extras, 'scaling.min') !== undefined && !extrasAlreadyExpanded(extras));
  const defaults = defaultCapacityReliability(input.env);
  const capacity = readEnum(extras.capacity, CAPACITIES, 'capacity') ?? defaults.capacity;
  const reliability = readEnum(extras.reliability, RELIABILITIES, 'reliability') ?? defaults.reliability;
  const size = CAPACITY_TABLE[capacity];
  const posture = RELIABILITY_TABLE[reliability];
  const profile: Record<string, unknown> = {
    'capacity.cpu': size.cpu,
    'capacity.memory': size.memory,
    'scaling.min': posture.scalingMin,
    'scaling.max': posture.scalingMin,
    'protect.fromDelete': posture.protectFromDelete,
    'ha.multiAz': posture.multiAz,
    'backup.retentionDays': posture.backupRetentionDays,
    'logs.retentionDays': posture.logsRetentionDays,
    'deploy.rolling.minHealthyPercent': 100,
    'deploy.rolling.maxHealthyPercent': 200,
    'deploy.circuitBreaker': true,
    'deploy.wait': true,
    'drain.timeoutSeconds': 60,
    'health.path': '/',
    'health.intervalSeconds': 30,
    'health.graceSeconds': 60,
  };
  // @intent Persist resolved capacity/reliability for stack posture / scaling
  const out: Record<string, unknown> = { ...profile, ...extras, capacity, reliability };
  if (packageSetMin) out[ORIGINAL_SCALING_MIN] = true;
  return out;
}

// @intent Keep package scaling.min distinct after profile expand
export function hasOriginalScalingMin(extras?: Record<string, unknown>): boolean {
  if (!extras) return false;
  if (extras[ORIGINAL_SCALING_MIN] === true) return true;
  return extraNumber(extras, 'scaling.min') !== undefined && !extrasAlreadyExpanded(extras);
}

const DATA_PLANE_CONSTRUCTS = new Set(['RdsPostgresInstance', 'AwsDocumentDbCluster', 'ElasticacheRedisCluster']);

export interface ProtectedReplacementInput {
  extras?: Record<string, unknown>;
  env?: string;
  existing?: boolean;
  appliedEngine?: string;
  appliedInstanceClass?: string;
}

// @intent Block engine/instance-class change on an existing protected store only
export function protectedReplacementReason(input: ProtectedReplacementInput): string | undefined {
  const extras = resolvePortableExtras({ env: input.env ?? 'development', extras: input.extras });
  if (extraBoolean(extras, 'protect.fromDelete') !== true) return undefined;
  if (!input.existing) return undefined;
  const engine = typeof extras.engine === 'string' ? extras.engine.trim() : '';
  const appliedEngine = input.appliedEngine?.trim() || (typeof extras.appliedEngine === 'string' ? extras.appliedEngine.trim() : '');
  if (engine && appliedEngine && engine !== appliedEngine) {
    return `Protected data-plane replacement blocked: engine ${appliedEngine} → ${engine}.`;
  }
  const instanceClass =
    typeof extras.instanceClass === 'string' ? extras.instanceClass.trim() : '';
  const appliedClass =
    input.appliedInstanceClass?.trim() ||
    (typeof extras.appliedInstanceClass === 'string' ? extras.appliedInstanceClass.trim() : '');
  if (instanceClass && (!appliedClass || instanceClass !== appliedClass)) {
    return `Protected data-plane replacement blocked: instance class change.`;
  }
  return undefined;
}

export function isDataPlaneConstruct(construct: string): boolean {
  return DATA_PLANE_CONSTRUCTS.has(construct);
}

export function extrasMarkExisting(extras?: Record<string, unknown>): boolean {
  return extras?.existing === true || extras?.['thonnas.existing'] === true;
}



