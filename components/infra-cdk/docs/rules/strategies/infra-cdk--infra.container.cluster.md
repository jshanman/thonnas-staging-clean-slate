# Strategy Implementation: infra.container.cluster

**Component:** infra-cdk  
**Construct:** `ECSFargateService` (single-AZ ECS + ALB)

## Implementation Notes
- Mapping lives in `src/registry/strategy-mapping.ts` (`infra.container.cluster.default`) and expects shared resources (VPC, public/private subnets, ECS cluster, ALB, HTTPS listener).
- `src/graph/dependency-graph.ts` dedupes those shared nodes per env and wires service-scoped nodes (target group, listener rule, log group, IAM roles, security groups, ECR repo).
- `src/stacks/ecs-service-stack.ts` defines the CDK stack for each runtime service (task definition, service, CloudWatch log group, ALB hook-up).
- Planner metadata includes hostname + routing extras so `buildCdkApp()` can generate deterministic listener rules and DNS names.

## Guidelines
- Always require both execution and task roles; if a service needs additional policies extend `planIamRoles()` in the resolver.
- Keep ingress limited to listener-managed traffic (security groups are created per service and should not allow 0.0.0.0/0 unless routed through ALB).
- When adding new runtime variants (e.g., queue workers), introduce a new `construct` or `requires` set rather than mutating the default cluster contract.


