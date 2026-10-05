# Strategy Implementation: infra.db.document

**Component:** infra-cdk  
**Variant:** `mongodb-compatible` (Amazon DocumentDB single-AZ cluster)

## Implementation Notes
- Strategy entry defined in `src/registry/strategy-mapping.ts` with the `AwsDocumentDbCluster` construct and dependencies (private subnet, DB SG, subnet group, secret, log group).
- `src/registry/resolve-strategies.ts` builds the required resources, ensuring SG ingress is limited to requesting services and secrets follow the `thonnas/{env}/{component}/documentdb` path.
- `src/graph/dependency-graph.ts` dedupes DocumentDB clusters per env/component pair so multiple strategies reusing the same doc store don’t double-provision.
- CDK synthesis is handled in the shared stack layer, exporting the cluster endpoint/port so ECS tasks or compose hosts can read them from SSM/Secrets Manager.

## Guidelines
- Keep the MVP cluster single-instance + single-AZ; document multi-AZ/high availability as a separate future enhancement.
- If components require TLS certificates or parameter group overrides, thread those values through `strategyExtras` rather than hardcoding them in the stack.
- When adding additional document engines, extend the `variants` map and ensure the resolver populates the same secret + SG metadata consumers expect.


