# infra-docker

Docker Compose orchestration component for managing multi-service container deployments using the [Docker Compose include pattern](https://docs.docker.com/reference/compose-file/include/).

**Component Key:** infra-docker  
**Component Type:** infra  
**Classification:** core-thonnas

## Purpose

Provides centralized Docker Compose orchestration for all containerized services in the Thonnas monorepo. This component uses the Docker Compose `include` feature to modularize compose files while maintaining a single orchestration point.

## Architecture

### Include Pattern

Each component maintains its own `docker-compose.yml` file in its component folder. This orchestration component includes all component compose files:

```yaml
include:
  - path: ../dbt-mongo/docker-compose.yml
  - path: ../dbt-postgres/docker-compose.yml
  - path: ../cache-redis/docker-compose.yml
  # ... all other components
```

**Benefits:**
- ✅ **Component Independence**: Each component defines its own services
- ✅ **Single Command**: Start all services from one location
- ✅ **Modular**: Add/remove components by updating include list
- ✅ **Consistent Networking**: Shared `thonnas-network` for all services

### Dependencies

This component provides both Docker containerization rules (Dockerfile patterns, image standards) and Docker Compose orchestration. It has no component dependencies. All other components with Docker Compose files depend on this component for orchestration.

## Usage

### Convenient NPM Scripts (Recommended)

From this component directory (`components/infra-docker/`):

```bash
# Start all services
npm run up

# Stop all services
npm run down

# View logs
npm run logs

# Check status
npm run ps

# Restart all services
npm run restart

# Validate configuration
npm run config
```

### From This Component Directory (Docker Compose)

```bash
cd components/infra-docker

# Start all services
docker compose up -d

# Stop all services
docker compose down

# View logs
docker compose logs -f

# Check status
docker compose ps
```

### From Project Root (Docker Compose)

```bash
# Start all services
docker compose -f components/infra-docker/docker-compose.yml up -d

# Stop all services
docker compose -f components/infra-docker/docker-compose.yml down

# View logs
docker compose -f components/infra-docker/docker-compose.yml logs -f

# Check status
docker compose -f components/infra-docker/docker-compose.yml ps
```

### Individual Services

```bash
# Start specific service (from project root)
docker compose -f components/infra-docker/docker-compose.yml up -d api-nest

# Start multiple services
docker compose -f components/infra-docker/docker-compose.yml up -d dbt-mongo cache-redis dbt-postgres
```

## Project and container naming

- **Compose project name** comes from the root `thonnas-package.json` `name` field (e.g. `thonnas-monorepo`) so the container group is consistent.
- **Container names** use the component/service name **without** a `thonnas-` prefix (e.g. `api-nest`, `reverse-proxy`) so that the reverse-proxy’s upstream hostnames (`api-nest:3000`, etc.) match the Docker network hostnames and routing works.

## Networking

All services share a common Docker network:

```yaml
networks:
  thonnas-network:
    driver: bridge
```

Services reference this network as `external: true` in their individual compose files. The `npm run up` script automatically creates the `thonnas-network` if it doesn't exist, so no manual setup is required.

## Beta / single-EC2 deploy

The same stack (including the reverse-proxy) runs on a **single EC2 instance** when deployed via the compose-host strategy (CDK). See [infra-cdk/docs/deploy-beta.md](../infra-cdk/docs/deploy-beta.md). The EC2 user-data clones the repo, writes `.env.thonnas` (with `THONNAS_ENV`, `*_HOST`, and `*_EXTERNAL_HOST` for each published service), and runs `docker compose up`. The reverse-proxy image is built on EC2 from the same context (routes script baked in); ensure **`generated/` is present** in the repo (run `npm run e2e-build` and commit `generated/` before deploying, or generate in CI).

## Environment Variables

Each component manages its own environment variables. See individual component folders for `ENV.local.example` files.

## Adding New Components

To add a new component to the orchestration:

1. Create the component's `docker-compose.yml` in its component folder
2. Add entries to `thonnas-infra.wiring.yaml` (docker_compose.include, reverse_proxy.routes, published_services as needed)
3. Add corresponding include/env lines to `docker-compose.yml` (with `# @component-include-{component}` annotations)
4. Run `npm run generate:infra` to regenerate `generated/` files
5. Ensure the component's services use the `thonnas-network`

## Troubleshooting

### Services Won't Start

```bash
# Check logs
docker compose -f components/infra-docker/docker-compose.yml logs [service-name]

# Verify configuration
docker compose -f components/infra-docker/docker-compose.yml config
```

### Network Issues

```bash
# Recreate network
docker network rm thonnas-network
docker compose -f components/infra-docker/docker-compose.yml up -d
```

### Port Conflicts

Check if ports are already in use:
```bash
# Windows
netstat -ano | findstr "3000"

# Linux/Mac
lsof -i :3000
```

## Compose-host and config

The **infra.container.compose-host** strategy (single-machine Compose for local dev and beta/EC2) keeps only `composeFile`, `workingDirectory`, and `publishedServices` in `thonnas-infra.json`. Git clone settings for EC2 deploy come from **thonnas-config** and are passed as env vars to the CDK/EC2 build script: `THONNAS_COMPOSE_GIT_REPO_URL`, `THONNAS_COMPOSE_GIT_BRANCH`, `THONNAS_COMPOSE_GIT_USERNAME`, `THONNAS_COMPOSE_GIT_PASSWORD_SECRET_NAME` (or `COMPOSE_*` variants). Set these in your config or environment when running infra plan/apply.

## Discovery-driven wiring

No wiring file: e2e-build discovers components that depend on this one and have `docker-compose.yml` (and optionally `docker-compose.override.yml`, `docker-compose.devtools.yml`). Run `npm run e2e-build` or `thonnas build` to produce:

- `generated/docker-compose.generated.yml` — include list + reverse-proxy service
- `generated/thonnas-infra.generated.json` — **only** `publishedServices` (generate-endpoints merges with base `thonnas-infra.json`)
- `generated/reverse-proxy-routes.txt` — route list (host|upstream|websocket); literal hostnames from e2e-build; mounted into reverse-proxy at runtime

Port conflict detection: if two components publish the same port, e2e-build fails with a clear error; fix by changing `default.endpoints.internal.default.port` or `strategies.runtime.ports` in one component's `thonnas-infra.json`.

## Internal Artifacts

| Artifact | Purpose |
|----------|---------|
| **scripts/e2e-build.ts** | Discovery-driven: finds components with compose files, builds publishedServices and routes, writes generated/ files. Run via `npm run e2e-build`. |
| **scripts/generate-endpoints.ts** | Merges `generated/thonnas-infra.generated.json` (publishedServices) into infra component when loading; outputs config/secrets. |
| **scripts/config/dockerSecrets.provider.js** | Used by `config-thonnas` for secret resolution. Reads `/run/secrets/*`, env vars, and `secrets/` files. |
| **docker-compose.override.yml** | Includes `generated/docker-compose.override.generated.yml`. Dev-only; Docker Compose auto-merges when present. |
| **reverse-proxy/entrypoint.sh** | Reads mounted `routes.txt` (host\|upstream\|websocket per line) and builds nginx config. Run `npm run e2e-build` with `THONNAS_ENV` and `THONNAS_ROOT_DOMAIN` so `generated/reverse-proxy-routes.txt` has literal hostnames and is mounted. |
| **--json-summary &lt;path&gt;** | Optional e2e-build flag: writes discovery summary JSON (debug only; not used by other scripts). |

## Install

Install via Thonnas CLI:

```bash
thonnas install @thonnas/infra-docker
```

Or add to `thonnas-package.json` dependencies and run `thonnas install`.

## Testing

```bash
cd components/infra-docker
npm test
```

Runs `test/reverse-proxy.test.ts` and `test/e2e-build.test.ts`.

## References

- [Docker Compose Include Documentation](https://docs.docker.com/reference/compose-file/include/)
- [Docker Compose CLI Reference](https://docs.docker.com/compose/reference/)
- [Thonnas Docker Rules](docs/rules/containerization-docker.md)


