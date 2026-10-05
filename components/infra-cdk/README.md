# infra-cdk

`infra-cdk` converts tech-agnostic `thonnas-infra.json` declarations into AWS-ready deployment intents. Phase 1 focuses on:

1. **Collector** – validates & merges infra intents from every component.
2. **Secrets** – file-backed secrets provider stored under `.thonnas/secrets/.env.<env>`.
3. **Planner CLI integration** – `thonnas infra plan --env <env>` prints deployment intent + secret summaries and writes `generated/<env>/deployment-intents.json`.

Phase 2 adds a **strategy registry** that maps abstract requirements (`infra.container.cluster`, `infra.db.relational`, etc.) to single-AZ AWS constructs and seeds derivative resources (per-service ECR repositories, IAM roles, security groups, and CloudWatch log groups). Engine variants (e.g., Postgres vs Aurora Postgres) are supported, along with hostname + routing metadata for ALB host-based routing. Phase 3 extends the pipeline with a dependency graph builder that deduplicates shared resources (VPC, ALB, ECS cluster) per environment and emits a DAG describing all nodes/edges for downstream CDK synthesis.

## Usage

- `npm run build` – compile TypeScript to `dist/`
- `npm run lint` – lint sources
- `npm run infra:plan -- --env beta [--root-domain thonnas.local] [--image-tag latest] [--git-tag v1.2.3] [--deploy-slug my-slug] [...]` – run the planner only
- `npm run infra:apply -- --env beta [...]` – plan + `aws-cdk deploy`
- `npm run infra:destroy -- --env beta [...]` – plan + `aws-cdk destroy`
- `npm run infra:identity-assume -- --env beta` – GitHub OIDC → IAM role, or no-op when the default AWS chain already works

These `infra:*` scripts are what the global `thonnas infra` commands invoke per provider component. **Shared** Thonnas flags (`--env`, `--root-domain`, …) are forwarded to every provider. **CDK-specific** flags are passed via npm-style `--infra-cdk:<name>=<value>` on `thonnas infra *` (see Thonnas CLI README); the provider script receives them as `--<name> <value>` (e.g. `--region`, `--account-id`).

## Testing

`npm run test` runs the Jest unit/integration suite (strategy resolution, the dependency graph builder, CDK stack synthesis assertions via `aws-cdk-lib/assertions`, and the identity/OIDC modules). Most tests are pure/offline; a few integration tests under `src/stacks/*.integration.test.ts` require Docker and are skipped automatically when it isn't available.

### Federated runner identity (GitHub OIDC)

CI must not store static `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in GitHub Secrets. `identity.assume` runs **before** `config.resolve`.

1. **One-time account bootstrap (laptop, admin/SSO):** run `thonnas config setup --env beta` so it prompts for non-secret `INFRA_CDK_GITHUB_ORG` and `INFRA_CDK_GITHUB_REPO` (GitHub owner and repo name). Those values are stored on the **consuming project** (`project/config.json` + `components/infra-cdk/.env.{env}`), not in this published package. Then `thonnas infra bootstrap --env beta` (or `thonnas infra apply --env beta`) from a machine that already has AWS credentials. That creates a deploy role trusted for this repo/env. If GitHub's OIDC IdP already exists in the account, apply **imports** it instead of creating a second provider (`EntityAlreadyExists` cannot be caught as CloudFormation success). The IdP is **retained** on `infra destroy` because it is account-wide. Copy `DeployRoleArn` into `project/config.json` as `INFRA_CDK_DEPLOY_ROLE_ARN` if apply did not write it. Optional: set `INFRA_CDK_OIDC_PROVIDER_ARN` to skip the IAM list lookup.
2. **GitHub-hosted runner:** the adapter enables OIDC (`id-token: write`). `thonnas infra identity assume --env "$THONNAS_ENV"` exchanges the GitHub JWT for that role and exports a session for later steps. `thonnas config resolve` then reads named secrets from Secrets Manager using that session.
3. **Local SSO / instance role:** if `aws sts get-caller-identity` already works, assume **no-ops** (exit 0) even when the role ARN is empty.

Do **not** paste AWS keys into GitHub. Laptop `config setup` may still collect keys for **local** plan/apply; that path is not used by federated CI.

Federation config is empty in **development**; OIDC stacks are not synthesized for that env.

These `infra:*` scripts are what the global `thonnas infra` commands invoke per provider component. **Shared** Thonnas flags (`--env`, `--root-domain`, …) are forwarded to every provider. **CDK-specific** flags are passed via npm-style `--infra-cdk:<name>=<value>` on `thonnas infra *` (see Thonnas CLI README); the provider script receives them as `--<name> <value>` (e.g. `--region`, `--account-id`).

### Provider CLI Contract

`infra-cdk` declares the `infra.cdk` strategy in `thonnas-package.json` and exposes the required npm scripts via the `thonnas.infra_provider` block. Any component that implements a two-segment `infra.{tool}` strategy must:

1. Define `thonnas.infra_provider.plan|apply|destroy` inside `thonnas-package.json`.
2. Implement matching npm scripts in `package.json`.
3. Support the shared Thonnas flags (`--env`, `--root-domain`, `--image-tag`, `--git-tag`, `--deploy-slug`, `--dry-run`, etc.) plus provider flags this script defines (`--account-id`, `--region`, …). From the repo root, CDK-specific values are often passed as `--infra-cdk:account-id=<id>` / `--infra-cdk:region=<region>` on `thonnas infra *` and forwarded as `--account-id` / `--region` to the provider.

```json
{
  "thonnas": {
    "implements_strategies": ["infra.cdk"],
    "infra_provider": {
      "key": "infra-cdk",
      "plan": "infra:plan",
      "apply": "infra:apply",
      "destroy": "infra:destroy",
      "identityAssume": "infra:identity-assume"
    }
  }
}
```

The root CLI discovers these providers automatically and shells out to `npm run <script> -- <flags>` inside each component directory (or to a specific component via `--component infra-cdk`). This keeps provider logic colocated with the component while allowing additional infra engines (Terraform, Pulumi, etc.) to plug into the same flow.

## Configuration (thonnas-config)

This component has a `thonnas-config.json` that declares **internal** env vars used at **deploy time** (when you run `infra:plan` / `infra:apply`). They are read on the machine running CDK and baked into EC2 user-data for compose-host; the instance does not need these env vars at runtime.

- **User-provided during thonnas config setup:** `THONNAS_COMPOSE_GIT_REPO_URL`, `THONNAS_COMPOSE_GIT_USERNAME`, `THONNAS_ROOT_DOMAIN` (and optionally branch, secret name).
- **Flow:** Run `thonnas config resolve` so `components/infra-cdk/.env.<env>` is generated from thonnas-config (with defaults). Edit that file or set the vars in your shell. When you run `infra:apply --env <env>`, the provider loads `.env.<env>` from this component dir, then runs the planner; `buildComposeMetadata` reads `process.env` and injects values into the EC2 user-data script (e.g. `REPO_URL`, `GIT_CLONE_USERNAME`).

See `env.local.example` in this component for the list of compose-related vars.

## Secrets

Secrets are stored in `.thonnas/secrets/.env.<env>` (gitignored) using hierarchical keys (`THONNAS__ENV__COMPONENT__SECRET`). `ensureSecret` lazily generates values and reuses them on subsequent runs. Future phases will introduce AWS Secrets Manager/KMS providers.

## Strategy Registry (Phase 2)

- **Listed strategies and usage:** See [docs/strategies.md](docs/strategies.md) for the full strategy list and how to use them (including **artifact deploy** and the optional `versionMatch` extra for single-version S3 uploads). That doc is the reference for humans and AI when configuring `thonnas-infra.json` per component.
- `src/registry/strategy-mapping.ts` enumerates each supported strategy with the AWS construct and required dependencies (VPC, subnets, SGs, IAM, log groups, etc.). Multi-AZ entries are intentionally omitted for the MVP.
- `resolveStrategies()` produces `ResolvedCloudComponent[]` (construct + hostname/ports metadata) and planned resources:
  - **ECR repositories:** `name = <env>-<component>`, `uriTemplate = {cloudAccount}.dkr.ecr.{region}.amazonaws.com/<name>`, lifecycle placeholder retaining last 5 images.
  - **Security groups:** ALB SG (shared), ECS task SG, EC2 SG, DB SG with the minimal ingress/egress rules described in FEAT-009.
  - **IAM roles:** ECS execution/task roles and EC2 host role with baseline managed policies.
  - **CloudWatch log groups:** `/thonnas/<env>/<component>` with 30-day retention.
- Host routing metadata is computed via `{env}.{component}.{rootDomain}` (prod omits env) and stored on each resolved component to drive ALB listener rules later.

## Dependency Graph (Phase 3)

- `buildDependencyGraph()` consumes deployment intents plus the strategy resolution output to produce an explicit DAG per environment (`generated/<env>/dependency-graph.json`).
- Shared resources (single-AZ VPC, subnets, ALB, ECS cluster, shared ALB security group) are created once per environment; service-scoped dependencies (target groups, listener rules, ECR repos, IAM roles, log groups) remain per-component.
- Nodes capture resource metadata (scope, hostname, runtime type, ports, availability), while edges document relationships (`runs_in`, `fronted_by`, `logs_to`, etc.) needed for CDK stack ordering.

## CDK App Generation (Phase 4)

- `buildCdkApp()` serializes the dependency graph + resolution into `components/infra-cdk/generated/<env>/cdk-app.js`. The entrypoint imports the runtime helper (`createCdkApp`) which instantiates:
  - `NetworkingStack` (single-AZ VPC, optional private subnet + NAT depending on env profile)
  - `EcsSharedStack` (ECS Cluster + shared ALB/listener when any service requires ALB routing)
  - `EcsServiceStack` (Fargate services with per-component log groups, SGs, ALB target groups, listener rules)
  - `Ec2ServiceStack` (beta/beta-feat EC2 docker hosts pulling container images from ECR)
- `createCdkApp` derives stack prefixes from env, project name, and optional **`--deploy-slug`** (sanitized into the stack name when scopes require per-deploy isolation). Requires explicit AWS account/region (via CLI options or `CDK_DEFAULT_*` env vars). Stacks synth to `generated/<env>/cdk.out`.
- New CLI commands:
  - `thonnas infra plan --env <env> [--git-tag <branch|tag>] [--deploy-slug <slug>] --infra-cdk:account-id=<id> --infra-cdk:region=<region>` (or pass `--account-id` / `--region` when invoking `npm run infra:plan` directly) → collector + registry + graph + cdk-app emission (no synth/deploy yet).
  - `thonnas infra apply` / `thonnas infra destroy` follow the same pipeline then execute `aws-cdk deploy|destroy --app "node .../cdk-app.js"` (requires AWS creds).
- Use **`--git-tag`** for the compose-host git checkout only. Use **`--deploy-slug`** for `{deploy-slug}` in hostnames/buckets and for stack isolation (Thonnas CLI pre-validates the slug).
- Image selection comes from `--image-tag` (default `latest`) with future flag for per-component overrides. No Docker builds occur inside infra-cdk—the CLI expects pre-pushed ECR tags.
- **Compose host strategy:** `infra.container.compose-host` (declared by `components/infra-docker`) provisions a single EC2 instance that clones the monorepo, runs `docker compose up`, and optionally maps published services to Route53 A-records when `hostedZoneId`/`hostedZoneName` extras are provided. Use **`--git-tag`** for checkout and **`--deploy-slug`** for per-deploy hostnames/buckets/stack scopes. Setting `monorepoDeploy: true` inside the compose host strategy instructs the planner to ignore every other component for that environment, effectively treating the entire repo as one deployable unit.

## Containerized AWS workflow

To keep host dependencies minimal you can run the entire infra toolchain inside Docker:

```bash
cd components/infra-cdk
npm run infra:docker-build          # builds thonnas/infra-cdk image (Node + AWS CLI + CDK)
npm run infra:aws-config            # launches aws configure inside the container (stored in named volume)
npm run infra:docker-shell          # drops into /workspace with repo mounted
```

- Credentials entered via `infra:aws-config` are written to the docker volume `thonnas-infra-aws-config` (mounted at `/root/.aws`). The host filesystem never gets a `~/.aws` folder, yet subsequent container sessions automatically reuse those credentials.
- `infra:docker-shell` mounts the repo at `/workspace`. Use the installed Thonnas CLI (e.g. `thonnas infra plan ...`) or install via `THONNAS_INSTALL_URL` (curl | sh) if not present. The AWS CLI and CDK CLI inside the image already honor the stored credentials.
- Override defaults with env vars: `THONNAS_INFRA_IMAGE` (custom image tag) and `THONNAS_INFRA_AWS_VOLUME` (alternate volume name). If you already maintain host-side AWS config you can skip the helper scripts and mount `~/.aws:/root/.aws` manually.
- Containers are now named automatically using `<project-name>-infra-cdk` (derived from the root `thonnas-package.json`). Set `THONNAS_INFRA_CONTAINER` if you need a custom name (useful when running multiple shells simultaneously). We also apply Docker Compose–style labels so the shell shows up under the same `{project}/{service}` grouping inside Docker Desktop; override via `THONNAS_INFRA_DOCKER_PROJECT` / `THONNAS_INFRA_DOCKER_SERVICE` if needed.

## LocalStack and awslocal (development)

For the **development** environment you can use [LocalStack](https://localstack.cloud/) as an S3-compatible endpoint so components (e.g. Verdaccio with `verdaccio-aws-s3-storage`) can store data locally without real AWS.

- **Start LocalStack** (includes S3 and Secrets Manager): `npm run localstack:start`
- **Stop:** `npm run localstack:stop`
- **Logs:** `npm run localstack:logs`

Point the AWS CLI at LocalStack with [awslocal](https://github.com/localstack/awscli-local) (or `AWS_ENDPOINT_URL`):

```bash
# Install awslocal (optional): pip install awslocal
export AWS_ENDPOINT_URL=http://localhost:4566

# Create an S3 bucket (e.g. for dependency-manager-verdaccio-development)
awslocal s3 mb s3://dependency-manager-verdaccio-development
# Or with plain AWS CLI:
aws --endpoint-url=http://localhost:4566 s3 mb s3://dependency-manager-verdaccio-development
```

Components that declare `infra.storage` with a `bucket` name in `thonnas-infra.json` will have that bucket created by infra-cdk when you deploy to beta/prod; in development, create the bucket in LocalStack as above and set `AWS_ENDPOINT_URL` (and optionally `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` to any value) so the app uses LocalStack.

## AWS MCP server (Cursor troubleshooting)

For AI-assisted troubleshooting of compose-host EC2 deployments (SSM Run Command, CloudWatch Logs, no SSH required):

- **Config:** `components/infra-cdk/.rulesync/mcp.json` — merged into root `.rulesync/mcp.json` by `generate-rules.sh`
- **Requirements:** Docker, bash, AWS credentials in `~/.aws` (or `%USERPROFILE%\.aws` on Windows)
- **Usage:** Run `generate-rules.sh`, restart Cursor. Then ask: "Find the beta compose host EC2 instance" or "Run `tail -100 /var/log/cloud-init-output.log` on the beta compose host"

## Troubleshooting deploy failures

When `aws-cdk deploy` fails with **Early Validation** (e.g. "The following hook(s)/validation failed: [AWS::EarlyValidation::ResourceExistenceCheck]"), get details with the DescribeEvents API:

```bash
aws cloudformation describe-events \
  --stack-name <StackName> \
  --change-set-name cdk-deploy-change-set \
  --region <Region> \
  --filters FailedEvents=true
```

- **NAME_CONFLICT_VALIDATION** – "Resource of type 'AWS::S3::Bucket' with identifier '...' already exists."  
  S3 bucket names are unique per account. If you moved a static-site stack to another region (e.g. us-east-1 for CloudFront/ACM), the old stack in the previous region still owns the bucket. Empty the bucket, delete the old stack in that region, then run `thonnas infra apply` again so the new stack can create the bucket in the target region.

- **UPDATE_ROLLBACK / "Cannot delete export ... as it is in use by ..."** – The Networking stack exports VPC and public subnet IDs. If the **new** template has fewer subnets (e.g. one AZ instead of two), CloudFormation tries to remove an export that another stack (e.g. `EcsShared`) still imports, and the update is rolled back. **Fix:** The runtime always passes `maxAzs: 2` when creating Networking so we never shrink and drop an export. To inspect in AWS:
  ```bash
  aws cloudformation list-exports --region <region> --query "Exports[?contains(ExportingStackId, 'Networking')]"
  aws cloudformation list-imports --export-name "<ExportName>" --region <region>
  ```

## Roadmap

- Multi-AZ/multi-region topologies, ACM automation, Route53 wiring, AWS Secrets Manager provider, IAM hardening.


