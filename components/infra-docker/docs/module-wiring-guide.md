# Module Wiring Guide: infra-docker

**Language**: yaml
**Framework**: Docker Compose

This component provides Docker Compose orchestration and does not install inline `tm-*` modules into other components. It wires infrastructure (compose includes, reverse-proxy) via discovery-driven `e2e-build`.

## Wiring Points

- **docker-compose.yml**: Includes component compose files via discovery-driven e2e-build
- **reverse-proxy**: Routes configured from `thonnas-infra.json` publishedServices

## Wiring Examples

### Discovery-driven stack

#### Input

```txt
# Component B: thonnas-package.json has no dependency on infra-docker
# OR no docker-compose.yml at component root
```

#### Output

```txt
# Component B: thonnas lists infra-docker; root docker-compose.yml exists
# e2e-build emits generated/docker-compose.generated.yml includes and routes
```

#### Symbols

- `e2e-build`
- `docker-compose.generated.yml`
- `publishedServices`

#### What Changed

Added dependency on `infra-docker` and a root `docker-compose.yml` (and `thonnas-infra.json` entries as needed) so the next `e2e-build` includes the component and publishes services.

## Unwiring Examples

### Remove component from generated stack

#### Input

```txt
# Component B listed in root install order with infra-docker + docker-compose.yml
```

#### Output

```txt
# Component B: dependency on infra-docker removed and/or compose file removed; e2e-build rerun
```

#### Symbols

- `e2e-build`
- `docker-compose.generated.yml`

#### What Changed

Removed `infra-docker` dependency and/or the component compose file so `e2e-build` no longer includes it in the aggregate compose graph.

## Notes

There are no `tm-*` module imports to wire or unwire in the application-code sense. The CLI still expects the sections above whenever `thonnas.wiring_file` is set.

