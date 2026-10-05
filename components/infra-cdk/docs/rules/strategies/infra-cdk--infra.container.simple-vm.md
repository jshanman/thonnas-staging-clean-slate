# Strategy Implementation: infra.container.simple-vm

**Component:** infra-cdk  
**Construct:** `SingleEC2DockerHost` (per-service EC2 instance running Docker Compose or a single container)

## Implementation Notes
- Strategy mapping in `src/registry/strategy-mapping.ts` references `SingleEC2DockerHost` and requires VPC, public subnet, EC2 instance profile, security group, ECR repo, and log group.
- `src/stacks/ec2-service-stack.ts` provisions the EC2 instance, attaches IAM policies for pulling images/secrets, sets up user data, and ships logs to CloudWatch.
- Planner metadata decides which ports are exposed and which Route53 records to publish; ensure `publishedServices` is set in the component’s `thonnas-infra.json`.

## Guidelines
- Keep the EC2 SG locked to required ports only. Use `securityGroups.ec2Service` helper to enforce east-west restrictions.
- If user data must change (extra bootstrap scripts, different compose command), edit `src/stacks/ec2-service-stack.ts` and re-run `npm run build && npm run infra:plan`.
- For multi-service nodes, prefer the `infra.container.compose-host` strategy; `simple-vm` should remain “one workload per instance”.


