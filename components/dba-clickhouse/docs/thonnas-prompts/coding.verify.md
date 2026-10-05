# dba-clickhouse: Coding Verify Guidance

## Bootstrap prove (IMPORTANT)

<!-- Phase 8 PI-5 / L-140 -->

- [ ] After bootstrap, ClickHouse listens on expected ports (`9000` / `8123` as applicable)
- [ ] Volume path ownership is correct for the ClickHouse user (no Keeper permission-denied loops)
- [ ] Provider surfaces still have no `clickhouse.com` install authorship

## Identity

- [ ] Package declares `infra.compute.fleet.dba`; provider only invokes bootstrap URL/script

