// @intent Union package extras into one LocalStack SERVICES string

export const LOCALSTACK_SERVICES_EXTRA_KEY = 'infra.aws.localstack.services';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @intent Walk thonnas-infra.json for infra.aws.localstack.services extras arrays */
export function collectLocalstackServicesFromInfra(infra: unknown): string[] {
  const found: string[] = [];
  walk(infra);
  return found;

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    const services = node[LOCALSTACK_SERVICES_EXTRA_KEY];
    if (Array.isArray(services)) {
      for (const item of services) {
        if (typeof item === 'string' && item.trim()) found.push(item.trim());
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === LOCALSTACK_SERVICES_EXTRA_KEY) continue;
      walk(value);
    }
  }
}

/** @intent Unique-sort contributed AWS API names into compose SERVICES value */
export function unionLocalstackServices(lists: Iterable<string>): string {
  const set = new Set<string>();
  for (const item of lists) {
    if (item.trim()) set.add(item.trim());
  }
  return [...set].sort((a, b) => a.localeCompare(b)).join(',');
}

