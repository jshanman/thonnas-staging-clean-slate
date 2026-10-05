# metrics-otel-signoz: Coding Draft Guidance

Production slot is **collector only** (`infra.observe.metrics`). Store peer is `infra.compute.fleet.dba` via `@thonnas/dba-clickhouse`.

## Release / boot hooks (CRITICAL)

<!-- Phase 8 PI-6 / L-137 / L-127 -->

- [ ] Release/hooks must produce a task **command/entryPoint** that builds clickhousetraces DSN from `THONNAS_DBA_FLEET_*` (password from secret env)
- [ ] Do not rely on `${env:...}` inside otel.yaml alone if the image defaults to localhost
- [ ] Keep product `SIGNOZ_*` / clickhousetraces keys **inside this package** — never ask infra-cdk to own them
- [ ] Provider `release --image-tag` is image-only; this package owns boot wiring

## Topology

- [ ] Do **not** declare `infra.observe.dashboard` on this package
- [ ] Depend on `@thonnas/dba-clickhouse`; peer fleet in staging/production infra

