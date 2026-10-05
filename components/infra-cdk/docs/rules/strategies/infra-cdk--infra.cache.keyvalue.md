# Strategy Implementation: infra.cache.keyvalue

**Component:** infra-cdk  
**Variant:** `redis` (Amazon ElastiCache)

## Implementation Notes
- Mapping defined in `src/registry/strategy-mapping.ts` (`infra.cache.keyvalue.redis`) requires VPC, private subnet, cache security group, and log group.
- `src/registry/resolve-strategies.ts` plans the Redis subnet group and SG rules, defaulting to single-AZ clusters sized for beta/release scale.
- The dependency graph exposes connection endpoints + secret references so consuming services can inject `CACHE_REDIS_HOST/PORT` style env vars during CDK synthesis.
- CDK resource synthesis happens in `src/stacks/ecs-shared-stack.ts` alongside other shared infrastructure to keep cache creation centralized.

## Guidelines
- Stick to single node, single-AZ for MVP; record multi-node/cluster mode as future work in the overview doc.
- Always pair cache SGs with explicit ingress from the consuming service SGs (no public access).
- If a new cache engine is needed, add another `variants` entry and keep the props minimal (name, node type, retention).


