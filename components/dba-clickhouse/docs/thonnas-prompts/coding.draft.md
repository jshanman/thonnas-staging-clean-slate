# dba-clickhouse: Coding Draft Guidance

Package owns ClickHouse/Keeper install on `infra.compute.fleet.dba`. Provider only invokes bootstrap.

## Fleet volume bootstrap (IMPORTANT)

<!-- Phase 8 PI-5 / L-140 -->

- [ ] Bootstrap `chown`s the fleet volume path to the ClickHouse user **before** starting server/Keeper
- [ ] Wait until native port (`:9000`) accepts connections; fail clearly if not ready
- [ ] Do not move bootstrap into `DbaFleetStack` UserData / `clickhouse.com` authorship in infra-cdk

## Strategy honesty

- [ ] Strategy key is `infra.compute.fleet.dba` — ClickHouse is the implementation
- [ ] No Signoz keys in this package’s portable contract

