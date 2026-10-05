# Strategy Implementation: infra.db.relational

**Component:** infra-cdk  
**Variants:** `postgres`, `aurora-postgres`

## Implementation Notes
- Variant mapping sits in `src/registry/strategy-mapping.ts`; both variants require VPC + private subnet, dedicated DB security group, subnet group, secrets, and CloudWatch logs.
- `src/registry/resolve-strategies.ts` plans resources such as `dbSecurityGroup`, `dbSubnetGroup`, and Secrets Manager entries; look there when adjusting port policies or rotation behavior.
- `src/graph/dependency-graph.ts` materializes those resources into the DAG so the CDK runtime can attach them to dependent services; shared DBs are deduped per `(env, component, engine)`.
- CDK stack provisioning occurs inside `src/stacks/ecs-shared-stack.ts` (subnet group, parameters) and service stacks consume the exported endpoints/secrets.

## Guidelines
- Keep single-AZ by default; document multi-AZ as future work rather than surfacing extra subnets today.
- When adding a new engine (e.g., MySQL), extend `StrategyRegistry` variants and ensure secrets/log retention requirements match AWS defaults.
- DB SG ingress should only allow callers planned by the resolver (ECS SG, compose host, etc.); avoid `0.0.0.0/0`.


