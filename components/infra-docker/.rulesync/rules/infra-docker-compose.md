---
root: false
targets: ["*"]
globs:
  - "components/infra-docker/**"
---

# infra-docker

Root orchestration for all containerized services via Docker Compose include pattern. Each component owns its compose file.

**Root:** `components/infra-docker`

**Strategies:**
- [`infra.container.compose-host`](../../docs/rules/strategies/infra-docker-compose--infra.container.compose-host.md) - Single-host Compose (local dev / single VM or EC2 for beta)
- [`infra.containers.docker-compose`](../../docs/rules/strategies/infra-docker-compose--infra.containers.docker-compose.md) - Compose orchestration
- [`infra.containers.docker`](../../docs/rules/strategies/infra-docker-compose--infra.containers.docker.md) - Docker patterns
- [`infra.containerization`](../../docs/rules/strategies/infra-docker-compose--infra.containerization.md) - Containerization
- [`config.container-images`](../../docs/rules/strategies/infra-docker-compose--config.container-images.md) - Image config
- [`infra.orchestration`](../../docs/rules/strategies/infra-docker-compose--infra.orchestration.md) - Service coordination
- [`config.deployment`](../../docs/rules/strategies/infra-docker-compose--config.deployment.md) - Deployment config

## Lifecycle Context
- **Requirements:** [review](../../docs/thonnas-prompts/planning.requirements.review.md)

