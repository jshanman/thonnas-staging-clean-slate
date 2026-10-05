# Deploy to beta (compose-host on current branch)

For **beta**, config-thonnas stores secrets in AWS Secrets Manager. Configure AWS **before** running setup.

## 1. AWS credentials (do this first)

config-thonnas requires a writable secret provider for beta. The AWS Secrets Manager provider activates when `AWS_REGION` is set.

**Laptop / first OIDC bootstrap:** use AWS SSO (`aws sso login --profile …`; do not run generic `aws configure`). Run `thonnas infra bootstrap --env beta` (or `thonnas infra apply --env beta --strategies infra.identity.oidc`) so the GitHub OIDC provider + deploy role exist, then commit `INFRA_CDK_DEPLOY_ROLE_ARN` from the stack output. That is account bootstrap, not a GitHub secret. A full unfiltered `infra apply` also creates buckets and sites.

**GitHub-hosted runners:** do not put `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in GitHub Secrets. The job should run `thonnas infra identity assume` (GitHub OIDC) then `thonnas config resolve`.

**Local no-op:** if your default AWS chain already works (SSO, instance role), `identity.assume` exits 0 without federation.

## 2. Config setup (one-time or when adding new secrets/config)

**Option A – Interactive (prompts for each value):**
```bash
cd /c/code/baseline-cursor-v3
npx thonnas config setup --env beta
# Enter CURSOR_API_KEY, THONNAS_COMPOSE_GIT_REPO_URL, THONNAS_COMPOSE_GIT_USERNAME, THONNAS_ROOT_DOMAIN,
# INFRA_CDK_GITHUB_ORG, and INFRA_CDK_GITHUB_REPO when prompted. Org/repo are non-secret; they land in
# the consuming project's project/config.json (not in the published infra-cdk package).
```

**Option B – Non-interactive (use an input file):**
```bash
cd /c/code/baseline-cursor-v3
cp secrets-beta.example.json secrets-beta.json
# Edit secrets-beta.json with real values (repo URL, git username, root domain, CURSOR_API_KEY).
npx thonnas config setup --env beta --non-interactive --input secrets-beta.json
```

(If you see "No writable secret provider", AWS credentials are missing or not in use.)

## 3. Resolve config

```bash
npx thonnas config resolve --env beta
```

## 4. Infra plan and deploy

From repo root:

```bash
REF=$(git branch --show-current)   # or use a tag: REF=v1.2.3
# Deploy slug: pre-validated label for hostnames/buckets/stack isolation (often derived from REF in Thonnas CLI).
SLUG=my-feature-slug
cd components/infra-cdk
npm run build
npm run infra:plan -- --env beta --git-tag "$REF" --deploy-slug "$SLUG"
npm run infra:apply -- --env beta --git-tag "$REF" --deploy-slug "$SLUG"
```

Optional: pass `--infra-cdk:account-id=...` and `--infra-cdk:region=...` on `thonnas infra *` if you don’t rely on default AWS config (or run `npm run infra:apply -- --account-id ... --region ...` from this component).

- **`--git-tag`**: git ref the compose-host EC2 checks out after clone (only affects checkout).
- **`--deploy-slug`**: used for `{deploy-slug}` in hostname/bucket patterns and for stack name isolation when scopes use per-deploy stacks; must match what you pass to `thonnas config resolve` for the same deploy.

## 5. EC2 config resolve (automatic)

When the compose host boots, user-data will:

1. Clone the repo and checkout the requested branch
2. Install Node.js, build config-thonnas and the CLI
3. Run `thonnas config resolve --env beta --skip-infra` to generate per-component `.env.beta` files
4. Secrets are fetched from AWS Secrets Manager via the EC2 IAM role (config-thonnas uses the `componentKey/env/secretName` pattern)
5. Write `.env.thonnas` (THONNAS_ENV, *_EXTERNAL_HOST) and run `docker compose up`

Components use `env_file: ./.env.${THONNAS_ENV}` so they load their resolved `.env.beta` files. Ensure `thonnas config setup --env beta` has been run on a machine with AWS credentials so secrets exist in Secrets Manager before deploying.

## 6. Generated compose and reverse-proxy (required for beta)

The stack runs `docker compose -f components/infra-docker/docker-compose.yml` from the repo root. That file includes `generated/docker-compose.generated.yml`, so **the `generated/` folder must exist in the repo** when EC2 runs (clone + checkout). Run e2e-build and commit:

- **Commit generated/** after running e2e-build locally:
  ```bash
  cd components/infra-docker
  npm run e2e-build
  git add generated/
  git commit -m "chore: update generated compose and reverse-proxy routes for beta"
  git push
  ```
- Or run e2e-build in CI and commit the `generated/` artifact before deploy.

The reverse-proxy image is built on EC2 from that context (routes script is baked in; no host mount). The EC2 `.env.thonnas` includes `*_EXTERNAL_HOST` for each published service so nginx gets the correct hostnames (e.g. `api.beta.<rootDomain>`).

