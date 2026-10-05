# Strategy Implementation: infra.container.compose-host

**Component:** infra-cdk  
**Construct:** `ComposeHostEc2` (single EC2 instance cloning the repo and running the top-level docker-compose)

## Implementation Notes
- Strategy mapping (`src/registry/strategy-mapping.ts`) requires VPC, public subnet, compose host instance + SG/role, elastic IP, Route53 records, and compose-specific log group.
- `src/stacks/compose-host-stack.ts` handles user data (git clone with Secrets Manager–backed password, checkout ref from **`--git-tag`**, `docker compose up --env-file .env.<env>`), host naming, `THONNAS_ENV` / `THONNAS_DEPLOY_SLUG` injection, and DNS creation.
- Planner extras from `thonnas-infra.json` (e.g., `monorepoDeploy`, `publishedServices`, root domain overrides) are surfaced via the dependency graph so the stack can wire all hostnames through a single ALB/EIP.

## Guidelines
- Keep compose host limited to beta/beta-feat environments; release/prod should use ECS unless explicitly overridden.
- Any new exposed service must be listed in `publishedServices` so Route53 + security rules know which ports to open.
- Do not bake secrets into user data; expect the git password secret (ex: `<module>_GIT_PWD`) and AWS creds to be present at apply time and document them in the CLI README. For local dry-runs, set `GIT_PASSWORD`/`SKIP_DOCKER_CMDS=true` to bypass Secrets Manager + Docker operations.


