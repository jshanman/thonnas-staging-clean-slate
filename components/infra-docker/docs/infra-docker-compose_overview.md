# Infra IAC Compose Overview (`infra-docker`)

## Purpose
- Provide a single source of truth for assembling the full docker-compose graph across all installed components.
- Define the `e2e-build` contract for discovering component compose files, validating them, and emitting the generated root compose.

## e2e-build Responsibilities
1. Discover installed components that declare a dependency on `infra-docker`.
2. For each component, locate its root-level `docker-compose.yml` (future TODO: support `thonnas:docker-compose` command output for dynamic includes).
3. Build a deterministic include list following dependency install order (break ties alphabetically).
4. Generate/overwrite `components/infra-docker/docker-compose.generated.yml` using the template at `docker-compose.yml` plus the discovered include entries.
5. Validate component compose files exist, contain services, and do not define duplicate service keys.
6. Emit structured logs summarizing inclusions, skips, and failures.

## Discovery Logic
- Inputs: root `thonnas-package.json` dependency graph or the installer’s resolved manifest.
- A component qualifies if:
  - Its `thonnas-package` lists `infra-docker` as a dependency.
  - A file exists at `<component>/docker-compose.yml`. (TODO: allow components to expose `scripts.thonnas:docker-compose` returning include metadata.)
- Ordering: traverse components in the same order the installer applies patches (topological order). If two components are independent, sort by component key.
- Skips: if a qualifying component lacks a compose file, log a warning and move on (do not fail the build). Repeated skips should be surfaced so owners can fix their packages.

## Output File Strategy
- Base template: `components/infra-docker/docker-compose.yml` retains shared comments and global network definitions.
- Generated file: `components/infra-docker/docker-compose.generated.yml` mirrors the template but replaces the `include` section with the discovered list and stamps metadata (timestamp, component count).
- Consumers (developers, CI) should run `thonnas run e2e-build --component infra-docker` and then reference the generated file when launching the stack (or copy it to project root if needed).

## Validation & Error Handling
- Missing compose file → warn + skip (include component key in message).
- Duplicate service names across includes → fail with actionable error listing conflicting components.
- Invalid YAML → fail fast; echo the parsing error plus component path.
- Missing dependency order info → fail, instructing the caller to run via the installer CLI so ordering metadata is available.
- Provide a JSON summary (stdout or log) enumerating included/ skipped components to aid automated troubleshooting.

## Logging & Observability
- Emit structured logs for:
  - Start/end of build (with elapsed time, counts).
  - Each included component (path, include index).
  - Each warning/error (reason, remediation hint).
- Future TODO: expose OTEL spans tagged with `component: infra-docker` and `operation: e2e-build`.

## TODO: Command-Based Include Support
- Some components may need to generate compose snippets dynamically.
- Future extension: if `scripts.thonnas:docker-compose` exists on a component, execute it and ingest its JSON output describing include paths or inline compose fragments.
- Until implemented, document this TODO in the component rule so module authors know the feature is forthcoming.

<!-- @intent Document how to run and test the e2e-build script -->
## Running the e2e-build Script
- CLI command (preferred): `thonnas run e2e-build --component infra-docker`
  - Generates `docker-compose.generated.yml` next to the template.
  - Fails if duplicate service names or malformed compose files are detected.
  - Warns (but continues) when a component declares the dependency but omits `docker-compose.yml`.
- Direct invocation (for local smoke tests): `npx ts-node --transpile-only ./scripts/e2e-build.ts --dry-run --verbose`
  - `--dry-run`: compute includes without writing the generated file.
  - `--verbose`: surfaces extra logging about discovery order.
  - `--json-summary ./summary.json`: writes a machine-readable report for CI.
- `npx ts-node --transpile-only ./scripts/e2e-build.ts` runs the script without going through `thonnas run`; add `--dry-run` or `--json-summary` as needed.

## References
- FEAT-007 plan and verification tasks: `components/pm-thonnas/docs/features/FEAT-007/e2e-build/phase2-container-orchestration-rules-docs.tasks.md`
- Architecture convention: `components/architecture-thonnas/docs/thonnas-architecture-overview.md#cross-component-build-workflow-feat-007`
- Strategy docs:
  - [`infra.containers.docker-compose`](rules/strategies/infra-docker--infra.containers.docker-compose.md)
  - [`infra.orchestration`](rules/strategies/infra-docker--infra.orchestration.md)
  - [`config.deployment`](rules/strategies/infra-docker--config.deployment.md)



