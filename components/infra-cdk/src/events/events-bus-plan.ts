// @intent Plan SNS topic + SQS queues/DLQs from project thonnas-events.json (keep in sync with queue-sns)
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'generated', 'coverage', '.next', '.turbo']);

export type EventsBusQueuePlan = {
  consumerId: string;
  queueName: string;
  dlqName: string;
  filterPolicy: {
    eventType: string[];
    aggregateId?: string[];
  };
};

export type EventsBusPlan = {
  env: string;
  topicName: string;
  queues: EventsBusQueuePlan[];
};

const ENV_CODES: Record<string, string> = {
  development: 'dv',
  local: 'dv',
  dev: 'dv',
  staging: 'st',
  production: 'pd',
  prod: 'pd',
  beta: 'bt',
};

// @intent Keep in sync with queue-sns claims-to-queues envCode / sanitizeBusProjectName
function envCode(env: string): string {
  const key = env.trim().toLowerCase();
  if (ENV_CODES[key]) return ENV_CODES[key];
  const compact = key.replace(/[^a-z0-9]/g, '');
  if (compact.length >= 2) return compact.slice(0, 2);
  if (compact.length === 1) return compact;
  return 'xx';
}

function sanitizeBusProjectName(projectName?: string): string {
  if (!projectName?.trim()) return '';
  const leaf = projectName.trim().split('/').pop() ?? '';
  const unscoped = leaf.startsWith('@') ? leaf.slice(1) : leaf;
  return unscoped
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

function renderBusName(env: string, projectName: string | undefined, suffix: string): string {
  const code = envCode(env);
  const project = sanitizeBusProjectName(projectName);
  const prefix = project ? `${project}-${code}` : code;
  return `${prefix}-thonnas-${suffix}`;
}

type EventSubscribeClaim = {
  consumerId?: string;
  events?: string[];
  filter?: { eventType?: string[]; aggregateId?: string[] };
};

function walkEventClaimFiles(rootDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name === 'thonnas-events.json') found.push(full);
    }
  };
  walk(rootDir);
  return found.sort((a, b) => a.localeCompare(b));
}

function claimsToQueues(raw: unknown): EventsBusQueuePlan[] {
  const file = raw as { subscribes?: EventSubscribeClaim[] };
  const subs = Array.isArray(file.subscribes) ? file.subscribes : [];
  const byId = new Map<string, EventsBusQueuePlan>();
  for (const sub of subs) {
    if (!sub || typeof sub.consumerId !== 'string' || !sub.consumerId.trim()) continue;
    const eventType = [
      ...(Array.isArray(sub.filter?.eventType) ? sub.filter.eventType : []),
      ...(Array.isArray(sub.events) ? sub.events : []),
    ]
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim());
    const uniqueTypes = [...new Set(eventType)];
    const aggregateId = Array.isArray(sub.filter?.aggregateId)
      ? sub.filter.aggregateId.filter((id) => typeof id === 'string' && id.trim())
      : undefined;
    const existing = byId.get(sub.consumerId);
    if (existing) {
      existing.filterPolicy.eventType = [...new Set([...existing.filterPolicy.eventType, ...uniqueTypes])];
      continue;
    }
    byId.set(sub.consumerId, {
      consumerId: sub.consumerId,
      queueName: '',
      dlqName: '',
      filterPolicy: {
        eventType: uniqueTypes,
        ...(aggregateId && aggregateId.length > 0 ? { aggregateId } : {}),
      },
    });
  }
  return [...byId.values()];
}

/** @intent One topic per project env; one queue + DLQ per consumerId from claims */
export function collectEventsBusPlan(
  projectRoot: string | undefined,
  env: string,
  projectName?: string,
): EventsBusPlan {
  const topicName = renderBusName(env, projectName, 'events');
  if (!projectRoot) {
    return { env, topicName, queues: [] };
  }
  const owners = new Map<string, string>();
  const merged = new Map<string, EventsBusQueuePlan>();
  for (const filePath of walkEventClaimFiles(projectRoot)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    for (const plan of claimsToQueues(parsed)) {
      const prior = owners.get(plan.consumerId);
      if (prior && prior !== filePath) {
        throw new Error(`Duplicate consumerId "${plan.consumerId}" in ${filePath} (already ${prior})`);
      }
      owners.set(plan.consumerId, filePath);
      merged.set(plan.consumerId, {
        ...plan,
        queueName: renderBusName(env, projectName, plan.consumerId),
        dlqName: renderBusName(env, projectName, `${plan.consumerId}-dlq`),
      });
    }
  }
  return {
    env,
    topicName,
    queues: [...merged.values()].sort((a, b) => a.consumerId.localeCompare(b.consumerId)),
  };
}



