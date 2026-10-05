# dba-clickhouse Component

ClickHouse DBA store for Thonnas. The portable strategy is **`infra.compute.fleet.dba`** — `infra-cdk` applies the private EC2 fleet (volumes, paths, IAM, secret slots, peer SG) and only **invokes** this package’s bootstrap. ClickHouse binary install, XML, users, and **colocated Keeper** live here.

**Component Key:** dba-clickhouse  
**Component Type:** dba  
**Package:** `@thonnas/dba-clickhouse`  
**Classification:** open-source

## Strategy ownership

| Concern | Owner |
|---|---|
| Private EC2 / volumes / secret ARN / peer SG | `infra-cdk` (`DbaFleetStack`) |
| ClickHouse install + start + listen + cluster/macros | this package (`scripts/bootstrap-clickhouse.sh`) |
| Coordination (Keeper) | **this package** (colocated) |
| Shared ZooKeeper strategy | **not used** — do **not** publish `infra.coord.zookeeper` |

## Features

- Declares `infra.compute.fleet.dba` for default / staging / production
- Fleet bootstrap via `scripts/bootstrap-clickhouse.sh` (`THONNAS_DBA_FLEET_SECRET_ARN`, `THONNAS_DBA_FLEET_VOLUME_PATH`)
- Local Docker Compose: `dba-clickhouse` + `dba-clickhouse-keeper`
- Native `:9000` and HTTP `:8123` endpoints + consumer derivations

## Install

```bash
thonnas component build . --yes --ai-provider inline
```

Ensure `@thonnas/infra-docker` is installed so the compose network resolves.

## Usage

```bash
docker compose up dba-clickhouse
```

- HTTP: `DBA_CLICKHOUSE_HTTP_HOST_PORT` (default `8123`)
- Native: `DBA_CLICKHOUSE_NATIVE_HOST_PORT` (default `9000`)

## Testing

No component-specific automated tests; verify the container is reachable with:

```bash
curl http://localhost:8123/ping
```

## Fleet bootstrap (AWS)

After `thonnas infra apply` creates the DBA fleet host, run (or let cicd `deploy.fleet-bootstrap` run):

```bash
export THONNAS_DBA_FLEET_SECRET_ARN=...
export THONNAS_DBA_FLEET_VOLUME_PATH=/var/lib/clickhouse
bash scripts/bootstrap-clickhouse.sh
```

`extras.bootstrapUrl` in `thonnas-infra.json` may point at a published copy of that script; empty means supply via release/SSM as documented by the fleet stack.

## Configuration

Exports (`thonnas-config.json`):

- `DBA_CLICKHOUSE_NATIVE_HOST` / `DBA_CLICKHOUSE_NATIVE_PORT`
- `DBA_CLICKHOUSE_HTTP_PORT`

Secrets (`thonnas-secrets.json`):

- `DBA_CLICKHOUSE_PASSWORD`

Provider portable exports on the fleet (not owned by this file): `THONNAS_DBA_FLEET_HOST`, `THONNAS_DBA_FLEET_SECRET_ARN`, `THONNAS_DBA_FLEET_VOLUME_PATH`.

## Implements Strategies

- `infra.compute.fleet.dba`

## Docker services

| Service | Image |
|---|---|
| `dba-clickhouse` | `clickhouse/clickhouse-server:25.5.6` |
| `dba-clickhouse-keeper` | `clickhouse/clickhouse-keeper:25.5.6` |

