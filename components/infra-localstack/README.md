# infra-localstack

One LocalStack AWS API emulator for local and development. This component owns the **container**. Installed packages **contribute** `SERVICES` via `thonnas-infra.json` extras `infra.aws.localstack.services`. **infra-docker e2e-build** unions them into `INFRA_LOCALSTACK_SERVICES`.

**Component Key:** infra-localstack  
**Component Type:** infra  
**env_scope:** development, local

## Install

Installed via the Thonnas marketplace as an `infra` component:

```
thonnas install @thonnas/infra-localstack
```

## Usage

Runs as a Docker Compose service (`infra-localstack`) alongside the rest of the
stack; no manual startup is required beyond `thonnas start`. Other components
contribute the AWS services they need via `thonnas-infra.json` extras
`infra.aws.localstack.services` (see Contributing SERVICES below), and read
`INFRA_LOCALSTACK_ENDPOINT` to talk to the emulator.

## Testing

No component-specific automated tests; verify the container is reachable with:

```
curl http://localhost:4566/_localstack/health
```

## What it is not

Not IaC for deployed AWS. Plan/apply stays on CDK or Terraform. Do not add a second LocalStack in queue-sns or infra-cdk.

## Exports

- `INFRA_LOCALSTACK_ENDPOINT` — default `http://infra-localstack:4566`
- `INFRA_LOCALSTACK_PORT` — default `4566`
- `INFRA_LOCALSTACK_REGION` — default `us-east-1`
- `INFRA_LOCALSTACK_SERVICES` — generated union (comma-separated)

## Migration alias

Network alias `infra-cdk-localstack` keeps `INFRA_CDK_S3_ENDPOINT=http://infra-cdk-localstack:4566` working.

## Contributing SERVICES

On a package `thonnas-infra.json`:

```json
"extras": {
  "infra.aws.localstack.services": ["sns", "sqs"]
}
```

Baseline: this package contributes `secretsmanager` (it is the development secret provider). infra-cdk contributes `s3,secretsmanager`. queue-sns contributes `sns,sqs`.

## Development secrets

`thonnas.secrets_provider` writes and reads development/local secrets through LocalStack Secrets Manager (`localstack-secrets-manager`). Secret ids match infra-cdk’s AWS Secrets Manager shapes. Deployed envs stay on infra-cdk `aws-secrets-manager`.

