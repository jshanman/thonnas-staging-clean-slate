# Strategy Implementation: infra.container.compose-host

**Component/Module:** infra-docker  
**Strategy:** `infra.container.compose-host`  
**Category:** infra.container  
**Purpose:** Run all services on a single host via Docker Compose (local dev or single VM / EC2 for beta).

---

## Implementation Approach

### Overview

This strategy means all services are run on one machine via Docker Compose. It works well for:

- **Local development** — one `docker compose up` on the developer machine.
- **Beta / simple VM** — a single EC2 (or other VM) runs the full stack; infra-cdk translates this into a compose-host EC2 stack that clones the repo and runs `docker compose` there.

### Key Artifacts

- `thonnas-infra.json` — strategy `composeHost` with `key: "infra.container.compose-host"` and extras: `composeFile`, `workingDirectory`, `publishedServices` (latter filled by e2e-build discovery).
- Git clone config for EC2 deploy is **not** in this file: it comes from **thonnas-config** and is passed as env vars to the CDK/EC2 build script (`THONNAS_COMPOSE_GIT_REPO_URL`, `THONNAS_COMPOSE_GIT_BRANCH`, `THONNAS_COMPOSE_GIT_USERNAME`, `THONNAS_COMPOSE_GIT_PASSWORD_SECRET_NAME`).

---

## Configuration

### Strategy extras (in thonnas-infra)

- `composeFile` — path to the compose file (e.g. `components/infra-docker/docker-compose.yml`).
- `workingDirectory` — directory on the host where the app is cloned and compose runs (e.g. `/opt/thonnas-app`).
- `publishedServices` — list of `{ name, port, protocol, hostnamePattern }` (discovery-generated).

### From thonnas-config (env vars for CDK/EC2)

- `THONNAS_COMPOSE_GIT_REPO_URL` / `COMPOSE_GIT_REPO_URL` — Git repository URL to clone.
- `THONNAS_COMPOSE_GIT_BRANCH` / `COMPOSE_GIT_BRANCH` — Branch to deploy (defaults to feature or `main`).
- `THONNAS_COMPOSE_GIT_USERNAME` / `COMPOSE_GIT_USERNAME` — Git clone username (optional).
- `THONNAS_COMPOSE_GIT_PASSWORD_SECRET_NAME` / `COMPOSE_GIT_PASSWORD_SECRET_NAME` — AWS Secrets Manager secret name for clone password.

---

## Related Strategies

- `infra.containers.docker-compose` — Compose file format and include pattern.
- `infra.orchestration` — Service coordination across the stack.
- `infra.iac` — CDK/EC2 stack that deploys the compose host.

