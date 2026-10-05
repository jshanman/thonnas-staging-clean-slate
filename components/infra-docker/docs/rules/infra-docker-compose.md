---
alwaysApply: true
description: 
---

# Component: Infra IAC - Docker Compose

## Summary

Root orchestration component that coordinates all containerized services using Docker Compose include pattern. Each component maintains its own compose file.

## When to Use

Required for local development and multi-service container orchestration. Use when running the full Thonnas stack.

**Specific Use Cases**:
- Local development environments
- Multi-service coordination
- Service networking and communication
- Volume management across services
- Environment-specific configurations
- Development stack bootstrapping
- Integration testing environments
- Service dependency management

## When NOT to Use

Avoid for production Kubernetes deployments or single-service deployments.

**Anti-patterns**:
- Production Kubernetes clusters
- Serverless deployments
- Single-container applications
- Cloud-managed services (ECS, Cloud Run)

## Technology Stack

- **Orchestrator**: Docker Compose v2
- **Pattern**: Include/merge compose files
- **Networking**: Docker networks
- **Volumes**: Docker volumes and bind mounts

## Integration Points

- **All Components**: Service definitions
- **Development**: Local stack management
- **Testing**: Integration test environments

## Configuration

Docker Compose configuration includes:
- Service definitions
- Network configurations
- Volume mappings
- Environment variables
- Dependency ordering
- Health checks
- Resource limits

<!-- @intent Link to cross-component build convention -->
For the global `build` vs `e2e-build` convention introduced in FEAT-007, refer to `components/architecture-thonnas/docs/thonnas-architecture-overview.md#cross-component-build-workflow-feat-007`. This component inherits that workflow and focuses on docker-compose aggregation specifics.
