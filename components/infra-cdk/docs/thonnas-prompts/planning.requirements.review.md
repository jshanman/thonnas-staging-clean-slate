# infra-cdk: Requirements Review Checklist

Review the feature.md for AWS CDK infrastructure considerations.

## Resource Planning (CRITICAL)

- [ ] AWS resources required are documented
- [ ] Resource naming conventions followed
- [ ] Cost estimates considered
- [ ] Region requirements specified

**Flag as CRITICAL if:**
- New infrastructure lacks resource identification
- No cost consideration for expensive resources

## Environment Strategy (CRITICAL)

- [ ] Environment tiers specified (beta/release/prod)
- [ ] Environment-specific configuration documented
- [ ] Promotion strategy between environments defined

**Flag as CRITICAL if:**
- Features lack multi-environment planning
- No promotion strategy defined

## Security (CRITICAL)

- [ ] IAM requirements documented
- [ ] Network security (VPC, security groups) specified
- [ ] Secrets management approach defined
- [ ] Encryption requirements identified

**Flag as CRITICAL if:**
- Security-sensitive features lack IAM planning
- Secrets handling not specified

## Scaling & Availability (IMPORTANT)

- [ ] Auto-scaling requirements documented
- [ ] High availability requirements specified
- [ ] Multi-AZ considerations addressed
- [ ] Load balancing requirements

**Flag as IMPORTANT if:**
- Production features lack HA planning
- No auto-scaling for variable load

## Database & Storage (IMPORTANT)

- [ ] RDS/DynamoDB requirements specified
- [ ] S3 bucket requirements documented
- [ ] Backup and retention requirements defined
- [ ] Data lifecycle policies considered

**Flag as IMPORTANT if:**
- Data storage lacks backup requirements
- No retention policy defined

## Monitoring & Alerting (NICE-TO-HAVE)

- [ ] CloudWatch alarms defined
- [ ] Dashboard requirements specified
- [ ] Log retention requirements

**Flag as NICE-TO-HAVE if:**
- Monitoring could be better specified

