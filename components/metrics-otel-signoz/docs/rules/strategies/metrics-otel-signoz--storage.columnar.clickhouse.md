# Strategy note: storage.columnar.clickhouse (MOVED)

**This package no longer implements or owns `storage.columnar.clickhouse`.**

| Was (metrics-otel-signoz) | Now |
| --- | --- |
| ClickHouse server + ZooKeeper/Keeper in this compose | `@thonnas/dba-clickhouse` |
| XML configs / UDF / volumes owned here | `dba-clickhouse` package (+ optional historical copies under `resources/common/clickhouse/` — see `OWNERSHIP.md`) |
| Strategy advertised in `implements_strategies` | Removed — production store key is `infra.compute.fleet.dba` |

## Where to look

- Package: `C:/code/thonnas-components/dba-clickhouse/components/dba-clickhouse/`
- Strategy key: `infra.compute.fleet.dba`
- Docs: `docs/rules/strategies/dba-clickhouse--infra.compute.fleet.dba.md` in that package

Collectors and dashboards **peer** the fleet store; they do not install ClickHouse.

