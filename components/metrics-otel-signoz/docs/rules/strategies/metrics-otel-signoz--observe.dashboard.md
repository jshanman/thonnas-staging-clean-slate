# Strategy Implementation: observe.dashboard

Local SigNoz UI helper for dashboards, service maps, flame graphs, and alert management. **Production** `infra.observe.dashboard` is owned by `@thonnas/dashboard-signoz` — this package's staging/production `thonnas-infra` no longer declares that key.

## Key Files

- `docker-compose.yml` – local `signoz` service exposes port `8080` and mounts dashboard resources.
- `resources/common/dashboards/` – curated dashboards copied from the upstream SigNoz repo and tracked in git.
- `resources/common/signoz/prometheus.yml` – controls dashboard data sources + alert rules (reads peer `dba-clickhouse`).

## How It Works

1. Dashboards are bundled via volume mount `./resources/common/dashboards:/root/config/dashboards`.
2. SigNoz loads JSON dashboards on startup; edits in this folder are detected on restart.
3. Alerts configured in `prometheus.yml` surface inside the SigNoz UI (Alerts tab).
4. Telemetry store DSN comes from `THONNAS_DBA_FLEET_*` / compose service `dba-clickhouse`.

## Customization Tips

- Add organization-specific dashboards by dropping JSON panels into `resources/common/dashboards`.
- For production auth/TLS/external access, prefer `dashboard-signoz` rather than this local helper.

## Validation

- After `dba-clickhouse` + this compose is up, navigate to `http://localhost:8080` and confirm dashboards render data.

