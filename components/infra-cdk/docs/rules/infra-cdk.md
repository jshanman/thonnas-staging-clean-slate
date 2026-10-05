# infra-cdk Component Overview

**Purpose:** Translate tech-agnostic `thonnas-infra.json` specs into AWS CDK stacks using a four-layer flow (collector → strategy mapping → dependency graph → CDK app emission) plus provider CLIs for plan/apply/destroy.

---

## Key Responsibilities
- **Collector (`src/planner/collector`)** – validates every component’s infra declaration, merges environment overrides, and deduplicates secrets.
- **Strategy Resolver (`src/registry`)** – maps abstract strategies to AWS constructs (ECS, EC2, RDS, DocumentDB, Elasticache, compose host).
- **Graph & Stacks (`src/graph`, `src/stacks`)** – dedupe shared resources (single-AZ VPC, ALB, ECS cluster) then emit stack constructs consumed by CDK runtime.
- **CDK Runtime (`src/cdk`)** – `buildCdkApp()` serializes the graph/resolution into `generated/<env>/cdk-app.js`, and `runtime.ts` wires the stacks.

## Provider Workflow
1. **Build once:** `npm run build` (generates `dist` for CLI + CDK runtime).
2. **Plan/apply/destroy:** `npm run infra:plan|apply|destroy -- --env beta --account-id <id> --region <region> [--root-domain ... --image-tag ... --git-tag ... --deploy-slug ...]`. From the repo root, `thonnas infra *` forwards shared flags plus npm-style `--infra-cdk:account-id=<id>` and `--infra-cdk:region=<region>` (see `thonnas.infra_provider.key`).
3. **Artifacts:** `components/infra-cdk/generated/<env>/deployment-intents.json`, `dependency-graph.json`, `cdk-app.js`, and `cdk.out/`.
4. **Dockerized toolchain:** `npm run infra:docker-build`, `npm run infra:aws-config`, `npm run infra:docker-shell` keep AWS credentials inside the named volume and mount the repo at `/workspace`.
5. **Secrets Manager provider:** `src/config/awsSecretsManager.provider.js` is loaded by `thonnas config setup` / `resolve` (path `components/infra-cdk/src/config/awsSecretsManager.provider`). It uses the host AWS credential chain (env or `aws configure`); it does not declare access keys in `thonnas-secrets.json`.

## Local AWS Sandbox (LocalStack)
- `npm run localstack:start` spins up `localstack/localstack` with Secrets Manager enabled (exposed on `http://localhost:4566`).
- `npm run localstack:stop` stops and removes the container; `npm run localstack:logs` tails its output.
- When running config resolve against LocalStack, set `AWS_REGION` and `AWS_SECRETS_MANAGER_ENDPOINT=http://localhost:4566` so the AWS provider persists secrets without touching a real AWS account.

## Common Tasks
- **Add new strategy mapping:** update `src/registry/strategy-mapping.ts`, extend `StrategyRegistry` types, and teach the graph builder how to provision required resources.
- **Update compose host flow:** edit `src/stacks/compose-host-stack.ts` (user-data, Route53 records, Git clone logic) and ensure planner metadata surfaces extras like `publishedServices`.
- **Expose new CLI flags:** wire options through `src/bin/infra-provider.ts`, `src/planner/plan.ts`, and the Thonnas CLI orchestrator.
- **Regenerate artifacts after edits:** `npm run build && npm run test && npm run infra:plan -- --env beta ...` to verify the CDK payload matches expectations.

Keep documentation/token usage lean—reference this overview from `.rulesync/rules/infra-cdk.md` and dive into source files for implementation details.

