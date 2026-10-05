---
root: false
targets: ["*"]
globs:
  - "components/infra-cdk/**"
---

# infra-cdk

AWS CDK provider translating `thonnas-infra.json` into deployable stacks. Handles strategy resolution, dependency graphs, and plan/apply/destroy flows. **Plan and apply are a sync:** they detect what exists in AWS and create only what is missing; no `use_existing_*` flags.

**Root:** `components/infra-cdk`

## Strategy → resource → stack mapping

Strategies in thonnas-infra (e.g. `infra.website.static`, `infra.artifact.deploy`, `infra.artifact.website-bucket`) map to **planned resource kinds** (e.g. `s3StaticSiteDeployment`, `s3ArtifactDeployment`, `s3WebsiteBucket`). There is not a 1:1 strategy-to-stack-file mapping: one **ArtifactStack** per component (in `src/stacks/artifact-stack.ts`) handles all bucket + Route53 + artifact deploy + static site resources for that component. So `infra.website.static` (static site) logic lives in **ArtifactStack** when `staticSiteResource` (kind `s3StaticSiteDeployment`) is present; there is no separate "staticWebsite" stack file.

**Strategies:**
- [`infra.cdk`](../../docs/rules/strategies/infra-cdk--infra.cdk.md) - CDK core
- [`infra.container.cluster`](../../docs/rules/strategies/infra-cdk--infra.container.cluster.md) - ECS clusters
- [`infra.container.compose-host`](../../docs/rules/strategies/infra-cdk--infra.container.compose-host.md) - EC2 compose
- [`infra.db.relational`](../../docs/rules/strategies/infra-cdk--infra.db.relational.md) - RDS

## Lifecycle Context
- **Requirements:** [review](../../docs/thonnas-prompts/planning.requirements.review.md)

