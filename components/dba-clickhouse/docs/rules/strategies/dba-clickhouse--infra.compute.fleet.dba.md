# Strategy Implementation: infra.compute.fleet.dba

**Component:** dba-clickhouse  
**Strategy:** `infra.compute.fleet.dba`  
**Category:** infra / compute  
**Purpose:** Package-owned ClickHouse (+ colocated Keeper) on a provider DBA fleet

---

## Overview

`dba-clickhouse` is the **product install** owner for ClickHouse on hosts applied by `infra-cdk`’s thin `DbaFleetStack`. The strategy key is portable (`infra.compute.fleet.dba`); ClickHouse is an implementation detail of this package.

## Split of responsibility

| Layer | Owns |
|---|---|
| Provider (`infra-cdk`) | Private EC2, durable volume path, IAM, Secrets Manager slot, peer SG, invoke-only UserData |
| This package | `scripts/bootstrap-clickhouse.sh`, compose CH+Keeper, users/XML, marketplace publish |

## Coordination

Keeper runs **inside** this package (bootstrap `keeper.xml` on fleet; `dba-clickhouse-keeper` in compose). Do **not** declare or depend on `infra.coord.zookeeper`.

## Extras contract

- `volumePath` — default `/var/lib/clickhouse`
- `servicePorts` — `[8123, 9000]` (HTTP + native)
- `bootstrapUrl` — optional HTTP(S) URL for the package bootstrap script; relative path documents the in-repo script for local/default

## Runtime env (fleet)

- `THONNAS_DBA_FLEET_SECRET_ARN` — Secrets Manager ARN (password for `thonnas` user)
- `THONNAS_DBA_FLEET_VOLUME_PATH` — durable data path on the host

## Related

- Provider strategy doc: `infra-cdk--infra.compute.fleet.dba` (in `@thonnas/infra-cdk`)
- Component README: [../../README.md](../../README.md)

