# metrics-otel-signoz: Publish / Release Notes

<!-- Phase 8 PI-6 -->

When publishing or releasing this package:

1. Ensure release hooks (or default container command) wire `THONNAS_DBA_FLEET_*` → collector DSN / migrate before the process starts.
2. Do not assume infra-cdk will inject Signoz boot into `ecs-fargate`.
3. After marketplace publish, inventeds prove must assert running task **command + env**, not only service stable.

