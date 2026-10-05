---
alwaysApply: true
description: 
---

# Component: Containerization - Docker (infra-docker)

## Summary

Provides Docker support, Dockerfile templates, and containerization patterns. Owned by infra-docker component.

## When to Use

Required for all components that need containerization (all components except mobile-flutter).

**Specific Use Cases**:
- Container image building
- Dockerfile standardization
- Multi-stage build patterns
- Container runtime configuration
- Image optimization
- Security scanning
- Layer caching strategies
- Development environment containers

## When NOT to Use

Avoid for mobile components or non-containerized deployments.

**Anti-patterns**:
- Native mobile applications
- Desktop applications
- Serverless-only deployments
- Static website hosting

## Technology Stack

- **Runtime**: Docker Engine
- **Build**: Docker Buildx, BuildKit
- **Images**: Alpine, Debian, Ubuntu base images
- **Registries**: Docker Hub, private registries

## Integration Points

- **All Backend Components**: Container packaging
- **Build Pipelines**: CI/CD containerization
- **Local Development**: Dev environment consistency

## Configuration

Docker configuration includes:
- Dockerfile templates
- Build arguments and env vars
- Image tagging strategies
- Multi-stage build optimization
- Security best practices

# Docker Containerization Rules

## Core Principles

### Container Philosophy
- **Stateless Containers**: Design containers to be stateless and disposable
- **Single Responsibility**: Each container should have one primary purpose
- **Immutable Infrastructure**: Treat containers as immutable after deployment
- **Environment Parity**: Maintain consistency across development, staging, and production
- **Security First**: Apply security best practices at every layer

## Language-Specific Guidelines

### Node.js Containers
- **Node Modules Management**:
  - Do not copy or map volumes for `node_modules`
  - Run `npm install` inside the container anytime `package.json` dependencies are updated
  - Use `.dockerignore` to exclude `node_modules` from build context
  - Use `npm ci` for production stage for faster, reliable installs

- **Multi-stage Builds**:
  - Use separate stages for development and production
  - Development stage: Include dev dependencies, debug tools, and file watchers
  - Production stage: Use minimal base images (e.g., `node:alpine`)
  - Copy only necessary files to production stage

- **Development Configuration**:
  - Start dev stage in debug mode with file watching
  - Expose debug ports (e.g., 9229 for Node.js debugging)
  - Mount source code as volumes for hot reloading
  - Use development-specific environment variables

## Dockerfile Best Practices

### Base Image Selection
- **Production**: Use minimal, security-focused images (alpine, distroless, scratch)
- **Development**: Use full-featured images with debugging tools
- **Version Pinning**: Always specify exact versions, never use `latest`
- **Security Scanning**: Regularly scan base images for vulnerabilities

### Layer Optimization
- **Minimize Layers**: Combine RUN commands where possible
- **Order Dependencies**: Place frequently changing layers last
- **Use .dockerignore**: Exclude unnecessary files from build context
- **Cache Optimization**: Structure Dockerfile to maximize layer caching

### Security Hardening
- **Non-root User**: Run containers as non-root user when possible
- **Minimal Attack Surface**: Remove unnecessary packages and tools
- **Secret Management**: Never embed secrets in images, use external secret management
- **Regular Updates**: Keep base images and dependencies updated

## Docker Compose Configuration

### Environment Management
- **Environment Files**: Expect `ENV.local` file in same component folder as Dockerfile for local development environment variables
- **Environment Mapping**: Map environment files to container environment variables
- **Default Values**: Provide sensible defaults for development environments

### Service Configuration
- **Service Dependencies**: Define proper service startup order with `depends_on`
- **Health Checks**: Implement health checks for all services
- **Resource Limits**: Set appropriate CPU and memory limits
- **Restart Policies**: Configure appropriate restart policies for different environments

### Networking
- **Network Isolation**: Use custom networks for service communication
- **Port Management**: Expose only necessary ports, use internal communication
- **DNS Resolution**: Leverage Docker's built-in DNS for service discovery
- **External Networks**: Connect to external networks when needed

## Development Workflow

### Local Development
- **Daemon Mode**: Use `docker compose up -d` for background operation
- **Log Inspection**: Use `docker compose logs -f [service]` for real-time log monitoring
- **Service Management**: Use `docker compose ps` to check service status
- **Cleanup**: Regularly run `docker compose down` and `docker system prune`

### Build and Deployment
- **Build Context**: Optimize build context size with `.dockerignore`
- **Multi-platform**: Support multi-platform builds when needed
- **Registry Management**: Use appropriate image registries and tagging strategies
- **Deployment Strategies**: Implement blue-green or rolling deployments

## Performance and Resource Management

### Image Optimization
- **Size Reduction**: Use multi-stage builds and minimal base images
- **Build Speed**: Leverage BuildKit and layer caching
- **Compression**: Use appropriate compression for image layers
- **Cleanup**: Remove build artifacts and temporary files

### Runtime Optimization
- **Resource Limits**: Set appropriate CPU and memory limits
- **Health Monitoring**: Implement comprehensive health checks
- **Logging**: Configure structured logging and log rotation
- **Monitoring**: Integrate with monitoring and alerting systems

## Security Guidelines

### Container Security
- **Image Scanning**: Regularly scan images for vulnerabilities
- **Runtime Security**: Use security-focused container runtimes when needed
- **Network Security**: Implement network policies and firewalls
- **Access Control**: Use proper authentication and authorization

### Secret Management
- **No Hardcoded Secrets**: Never embed secrets in images or compose files
- **External Secrets**: For production, expect to use Docker secrets, Kubernetes secrets, or external secret managers. For local dev, dummy secrets are ok in the ENV.local file.
- **Rotation**: For production, Implement secret rotation policies
- **Audit**: For production, Log and monitor secret access

## Troubleshooting and Debugging

### Common Issues
- **Container Won't Start**: Check logs, environment variables, and resource constraints
- **Network Issues**: Verify network configuration and service discovery
- **Performance Problems**: Monitor resource usage and optimize accordingly
- **Build Failures**: Check Dockerfile syntax, base image availability, and build context

### Debugging Tools
- **Container Inspection**: Use `docker inspect` for detailed container information
- **Log Analysis**: Use structured logging and log aggregation tools
- **Resource Monitoring**: Monitor CPU, memory, and network usage
- **Health Checks**: Implement and monitor health check endpoints

## CI/CD Integration

### Build Pipeline
- **Automated Builds**: Trigger builds on code changes
- **Testing**: Run tests in containerized environments
- **Security Scanning**: Integrate vulnerability scanning in CI/CD
- **Registry Management**: Push to appropriate registries with proper tagging

### Deployment Pipeline
- **Environment Promotion**: Promote images through dev → staging → production
- **Rollback Strategy**: Implement quick rollback capabilities
- **Configuration Management**: Manage environment-specific configurations
- **Monitoring**: Integrate deployment monitoring and alerting

## Monitoring and Observability

### Health Monitoring
- **Health Checks**: Implement application and infrastructure health checks
- **Metrics Collection**: Collect container and application metrics
- **Log Aggregation**: Centralize and structure container logs
- **Alerting**: Set up alerts for critical issues

### Performance Monitoring
- **Resource Usage**: Monitor CPU, memory, and network usage
- **Application Metrics**: Track application-specific performance metrics
- **Dependency Monitoring**: Monitor external service dependencies
- **Capacity Planning**: Use metrics for capacity planning and scaling decisions

