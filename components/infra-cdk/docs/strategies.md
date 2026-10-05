# infra-cdk: Listed strategies

This document describes the strategies that infra-cdk supports (see `src/registry/strategy-mapping.ts`). Components declare strategies and env-specific `extras` in their `thonnas-infra.json`; infra-cdk stays component-agnostic and uses only those declarations.

## Strategy list (summary)

| Strategy key | Construct | Scope |
|--------------|-----------|--------|
| `infra.container.cluster` | ECSFargateService | service |
| `infra.container.managed-host` | ECSFargateService | service |
| `infra.container.simple-vm` | SingleEC2DockerHost | service |
| `infra.container.compose-host` | ComposeHostEc2 | service |
| `infra.db.relational` | RdsPostgresInstance / AuroraPostgresCluster | (variants) |
| `infra.cache.keyvalue` | ElasticacheRedisCluster | (variants) |
| `infra.db.document` | AwsDocumentDbCluster | (variants) |
| `infra.artifact.deploy` | ArtifactDeploy | service |
| `infra.artifact.website-bucket` | S3WebsiteBucket | service |
| `infra.website.static` | S3StaticSiteDeployment | service |
| `infra.storage` | S3StorageBucket | service |
| `infra.api.storage-temp-url` | StorageTempUrlApi | service |
| `infra.identity.oidc` | GithubOidc | shared |
| `comms.events.pub-sub.sns` | SnsSqsEventBus | shared |
| `infra.bootstrap` | (local command, not a CDK stack) | — |

Details for container, DB, and cache strategies are in the README and strategy-mapping.

---

## infra.identity.oidc (GitHub OIDC deploy role)

Planned as resource kind `githubOidcIdentity`. Synthesized as `GithubOidcStack` only when this strategy is in resolution — not merely because `INFRA_CDK_GITHUB_ORG` / `INFRA_CDK_GITHUB_REPO` are set. Typical declarer is `cicd-github-actions` with `extras.issuer: "github"`.

Create the stack with `thonnas infra bootstrap --env <env>` or `thonnas infra apply --env <env> --strategies infra.identity.oidc`. Tear it down with the same `--strategies` filter on destroy so artifact buckets and sites stay.

`infra.bootstrap` is this package’s local SSO/profile command (`scripts/bootstrap.sh`, priority 0, empty `applyStrategies`). The planner skips it; it is not a cloud construct.

---

## comms.events.pub-sub.sns (domain event bus)

Declared by `queue-sns`. At plan time infra-cdk walks the project for `thonnas-events.json` and synthesizes:

- One SNS topic `{env}-thonnas-events`
- One SQS queue `{env}-thonnas-{consumerId}` plus DLQ `{env}-thonnas-{consumerId}-dlq` (`maxReceiveCount` 5)
- SNS→SQS subscriptions with `eventType` (and optional `aggregateId`) filter policies and raw message delivery

On compose-host (beta) and managed-host (Fargate), the instance/task role gets `sns:Publish` and SQS consume on those queues. `QUEUE_SNS_TOPIC_ARN` / `QUEUE_SNS_QUEUE_URL_MAP` are written into the host/task env. Non-prod stacks use `RemovalPolicy.DESTROY` so `infra destroy` can wipe the bus.

---

## infra.api.storage-temp-url (storage temporary URL API)

Used by a component that declares `infra.api.storage-temp-url` to provision an API (Lambda + CloudFront + Route53 in the AWS implementation) that issues short-lived temporary URLs for storage/artifact access. Storage is kept private; the install script fetches a temp URL at runtime. Strategy name is vendor-agnostic; the CDK implementation uses Lambda and S3 presigned URLs. The Lambda handler is loaded from the declaring component (`extras.handlerPath`, default `src/handler.js`).

### Extras

| Field | Meaning |
|-------|---------|
| `bucket` | S3 bucket name (same bucket used by artifact deploy) |
| `bucket_region` | AWS region of the bucket (required when Lambda runs in another region so presigned URLs use the correct S3 endpoint) |
| `prefix` | S3 key prefix (e.g. `beta`) |
| `api_domain` | Public hostname for the API (e.g. `install.{env}.{rootDomain}`) |
| `hosted_zone_domain` | Route53 hosted zone (e.g. `{rootDomain}`) |
| `handlerPath` | Optional path to the Lambda handler relative to the declaring component root (default `src/handler.js`) |

Requires ACM cert and us-east-1 for CloudFront. Run `thonnas infra plan` and `thonnas infra apply`; first run may need two applies after ACM validation.

---

## infra.storage (S3 bucket for app data)

Used to provision a private S3 bucket for component data. One bucket per `infra.storage` strategy.

- **`bucket`**: literal name or template (`{deploy-slug}`, `{env}`, etc.). Legacy `{env.VAR}` reads `process.env.VAR` during `thonnas infra plan` (must be set before plan).
- **`bucketFromEnv`**: name of an env var (e.g. `MY_COMPONENT_S3_BUCKET`) that **config resolve / build** will set at runtime. It is **not** read from config during plan. During `infra plan`/`apply`, the planner resolves the bucket from `process.env[bucketFromEnv]` if set; otherwise it reads the **default pattern** for that key from the component `thonnas-config.json` `internal` entry with matching `name`, then expands it with **`--deploy-slug`** and env (same rules as `{deploy-slug}` in hostnames). That avoids a chicken-and-egg where infra referenced `{env.MY_COMPONENT_S3_BUCKET}` before config resolve existed.

### Extras

| Field | Meaning |
|-------|--------|
| `bucket` | S3 bucket name or template. Must be globally unique in the account. |
| `bucketFromEnv` | Env var name whose value is the bucket at runtime; planner derives plan-time name from `thonnas-config.json` default pattern + `deploy-slug` when the var is unset. |

### Same-component link to runtime

When a component declares **both** `infra.container.simple-vm` (or other EC2 runtime) and `infra.storage` in the same `default.strategies` / env, infra-cdk automatically grants the EC2 instance role permission to read, write, and delete objects in that bucket (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`). No extra field is required: the planner sees both strategies on the same component and wires the IAM policy.

Example (`my-storage-component/thonnas-infra.json`):

```json
{
  "default": {
    "strategies": {
      "runtime": { "key": "infra.container.simple-vm", "ports": [4873], "exposed": true },
      "storage": { "key": "infra.storage", "bucket": "my-storage-component-beta" }
    }
  },
  "environments": {
    "development": {
      "strategies": {
        "storage": { "key": "infra.storage", "bucket": "my-storage-component-development" }
      }
    }
  }
}
```

In development, use LocalStack + awslocal to create the bucket locally; see README “LocalStack and awslocal”.

---

## Linking runtime to storage (ideas for explicit links)

When the runtime and storage live in the **same component**, infra-cdk already links them (see above). For cross-component or explicit declaration, these patterns are possible future extensions:

| Idea | Description |
|------|-------------|
| **`usesStrategy` / `consumes`** | In `runtime.extras`: `usesStrategy: "storage"` or `consumes: ["storage"]`. Planner resolves the named strategy’s bucket and adds a graph edge; CDK grants the runtime role access to that bucket. |
| **`bindings`** | Top-level `default.bindings: [{ "from": "runtime", "to": "storage", "actions": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"] }]`. Explicit and flexible for multiple actions or resources. |
| **`storageRef`** | In `runtime.extras`: `storageRef: "storage"` (reference by strategy name). Same as usesStrategy but single ref. |
| **`dependsOn` at strategy level** | Each strategy can have `dependsOn: ["storage"]`; graph builder adds edges and CDK passes bucket ARN/name to dependents and attaches IAM. |

Goal of any link declaration: so infra-cdk can set up IAM (and optionally VPC/network) so the runtime (e.g. EC2) can read, write, and delete objects in the S3 bucket. Same-component link is implemented; cross-component or schema for bindings can be added when needed. Below is the **artifact deploy** contract so humans and AI can discover and use the `versionMatch` feature.

---

## infra.artifact.deploy (artifact upload to S3)

Used to upload versioned build artifacts (e.g. CLI binaries) to an S3 bucket. Behavior is driven entirely by each component’s `thonnas-infra.json` per env under `strategies.artifactDeploy.extras`.

### Extras (from component `thonnas-infra.json`)

| Field | Meaning |
|-------|--------|
| `artifactPath` | Path template: `{{repo_root}}`, `{{version}}`, optional `{{platform}}`, `{{arch}}`. Resolved using the version from `versionMatch` when set, or the default version source. |
| `bucketEnv` | Env var name for the S3 bucket (e.g. `MY_COMPONENT_S3_BUCKET`). |
| `prefixEnv` | Env var name for the S3 key prefix (e.g. `MY_COMPONENT_S3_PREFIX`). |
| `set_latest_link` | If true, write `{prefix}/latest` with `{ "version": "<version>" }`. |
| **`versionMatch`** | **Optional.** When set, the deploy uses a **single version** derived from a file under the **component root**. Only artifacts whose path matches that version are uploaded. When unset, infra-cdk uses its default version source and upload behavior. |

### versionMatch (recommended for single-version uploads)

- **Shape:** `{ "versionFile": "<path>", "versionField": "<field>" }`
- **Paths:** Relative to the **component root** (e.g. `thonnas-package.json` or `package.json`).
- **Behavior when set:**
  1. Resolve component root (the directory containing the component’s `thonnas-infra.json`).
  2. Read the JSON file at `versionFile` and take the value at `versionField` (e.g. `version`).
  3. Resolve `artifactPath` with that version (and optional `{{platform}}`, `{{arch}}`).
  4. Upload **only** files that exist at those resolved paths (no glob of all versions).
- **When unset:** Version source and which files are uploaded follow infra-cdk’s default behavior (e.g. upload all artifacts in the artifact dir if that’s how the apply step is implemented).

Example (in a component’s `thonnas-infra.json`, under e.g. `beta.strategies.artifactDeploy.extras`):

```json
{
  "artifactPath": "{{repo_root}}/dist/mycli-{{version}}-{{platform}}-{{arch}}",
  "bucketEnv": "MY_COMPONENT_S3_BUCKET",
  "prefixEnv": "MY_COMPONENT_S3_PREFIX",
  "set_latest_link": true,
  "versionMatch": {
    "versionFile": "thonnas-package.json",
    "versionField": "version"
  }
}
```

This ensures only the version from `thonnas-package.json` is uploaded, and is the preferred way to get robust, single-version artifact deploys.

### Contract reference

For the full artifact-deploy contract (upload rules, template-only paths, multi-artifact platform/arch), see the component-side doc: **`components/<component>/docs/infra-artifact-deploy-contract.md`**. Infra-cdk does not hardcode component names or artifact names; it only uses the template and extras from each component’s `thonnas-infra.json`.

---

## infra.website.static (S3 + CloudFront static site)

Deploys a component build output as a CloudFront-fronted static site. Behavior is driven by `strategies.staticSite.extras` in the component’s `thonnas-infra.json`.

### Common extras

| Field | Meaning |
|-------|---------|
| `outputPath` | Build output directory relative to the component root (e.g. `build`) |
| `website_domain` | Public hostname template (e.g. `{env}.docs.{rootDomain}`) |
| `hosted_zone_domain` | Route53 hosted zone |

### Optional `accessControl` (frontend cookie gate)

When present, infra-cdk generates a CloudFront viewer-request function. **All product-specific values come from the component** — the provider does not default a challenge path (e.g. no hardcoded `/terms`).

| Field | Required | Meaning |
|-------|----------|---------|
| `type` | yes | Must be `frontend-cookie-gate` |
| `cookieName` / `cookieValue` | yes | Gate cookie name and accepted value |
| `challengePath` | yes* | Unauthenticated challenge page path (e.g. `/terms`). Alias: `termsPath` |
| `cookieTtlDays` | no | Cookie Max-Age in days (default `30`) |
| `cookiePath` | no | Cookie `Path` (default `/`) |
| `cookieSecure` | no | Include `Secure` (default `true`) |
| `cookieSameSite` | no | Cookie `SameSite` (default `Lax`) |
| `returnParam` | no | Query param for post-accept redirect (default `return`) |
| `publicPaths` | no | Extra public URI patterns; challenge path + `challengePath/*` are always public |
| `queryBypass` | no | One rule or array of `{ param, values, setCookie? }` for query-param unlock |

\*One of `challengePath` or `termsPath` is required; without it the gate is not enabled (directory-index rewrite only).

Example:

```json
{
  "accessControl": {
    "type": "frontend-cookie-gate",
    "cookieName": "my_site_gate",
    "cookieValue": "accepted-v1",
    "cookieTtlDays": 30,
    "cookiePath": "/",
    "cookieSecure": true,
    "cookieSameSite": "Lax",
    "challengePath": "/gate",
    "returnParam": "return",
    "publicPaths": ["/gate", "/gate/*", "/favicon.ico"],
    "queryBypass": {
      "param": "unlock",
      "values": ["true", "yes"],
      "setCookie": true
    }
  }
}
```

Config-only gate changes require `thonnas infra apply` so the CloudFront function is updated.

