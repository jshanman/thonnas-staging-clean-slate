---
alwaysApply: true
description: LocalStack is owned by infra-localstack; packages contribute SERVICES extras only
---

# Component: Infra LocalStack

## Summary

One LocalStack container for local AWS APIs. Feature modules never import AWS SDK types from this package.

## When to Use

Local SNS/SQS, S3, or Secrets Manager without a live AWS account. `thonnas start` via infra-docker.

## When NOT to Use

Deployed AWS. A second LocalStack. Treating this as plan/apply IaC.

## Rules

- Do not add AWS SDK types to feature-module rules.
- Contribute services via extras `infra.aws.localstack.services`; do not overlay `SERVICES` on this compose service from other packages.
- This component is the development/local secret provider (LocalStack Secrets Manager). Do not put a development `secrets_provider` on infra-cdk.

