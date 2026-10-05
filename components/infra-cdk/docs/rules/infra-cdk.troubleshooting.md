# infra-cdk Troubleshooting

**Component:** infra-cdk  
**Focus:** Compose-host EC2 deployment (single instance running docker compose from cloud-init)

## AWS MCP for Remote Troubleshooting

When `awslabs.aws-api-mcp-server` is configured in Cursor MCP (see `components/infra-cdk/.rulesync/mcp.json`), use the `call_aws` tool to troubleshoot the compose-host EC2 **without SSH**. The instance has SSM (AmazonSSMManagedInstanceCore) — SSM Run Command works.

Set `AWS_REGION` (or pass `--region`) to the region of the compose-host stack.

### Step 1: Discover the EC2 Instance

Use `call_aws` with:

```bash
aws ec2 describe-instances --region "$AWS_REGION" \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=*ComposeHost*" "Name=instance-state-name,Values=running" \
  --query "Reservations[*].Instances[*].[InstanceId,Tags[?Key=='Name'].Value|[0],State.Name]" --output table
```

Or by Name tag (e.g. `*-compose`):

```bash
aws ec2 describe-instances --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=*-compose" "Name=instance-state-name,Values=running" \
  --query "Reservations[*].Instances[*].[InstanceId,Tags[?Key=='Name'].Value|[0]]" --output json
```

Capture the `InstanceId` (e.g. `i-0abc123...`) for later steps.

### Step 2: Run Commands on the Instance (SSM Run Command)

Use `aws ssm send-command` to execute shell commands on the EC2. Then fetch output with `aws ssm get-command-invocation`.

**Cloud-init log** (primary source for deploy failures):

```bash
aws ssm send-command --region "$AWS_REGION" \
  --instance-ids "i-INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["tail -200 /var/log/cloud-init-output.log"]'
```

**Compose-host logs** (user-data script output):

```bash
aws ssm send-command --region "$AWS_REGION" \
  --instance-ids "i-INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["tail -200 /var/log/compose-host/current.log 2>/dev/null || echo no log"]'
```

**Docker compose status**:

```bash
aws ssm send-command --region "$AWS_REGION" \
  --instance-ids "i-INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["cd /workspace 2>/dev/null || cd /opt/app 2>/dev/null || ls -la; docker compose ps 2>/dev/null || docker ps"]'
```

**Get command output** (use `CommandId` from send-command response):

```bash
aws ssm get-command-invocation --region "$AWS_REGION" \
  --command-id "COMMAND_ID" \
  --instance-id "i-INSTANCE_ID" \
  --query "[Status, StandardOutputContent, StandardErrorContent]"
```

Poll until `Status` is `Success` or `Failed`. If `InProgress`, wait a few seconds and retry.

**Save full invocation to infra-cdk generated** (canonical location; do not save at project root):

```bash
# From repo root:
cd components/infra-cdk
npm run fetch:ec2-invocation -- --command-id "COMMAND_ID" --instance-id "i-INSTANCE_ID" [--region "$AWS_REGION"]
```

This writes `components/infra-cdk/generated/ec2-invocation.json`. If using AWS CLI directly, redirect output there:  
`aws ssm get-command-invocation ... --output json > components/infra-cdk/generated/ec2-invocation.json`

### Step 3: CloudWatch Logs

Log group: `/thonnas/{stackPrefix}-{component}-compose`.

```bash
aws logs describe-log-streams --region "$AWS_REGION" \
  --log-group-name "/thonnas/{stackPrefix}-{component}-compose" \
  --order-by LastEventTime --descending --limit 3
```

Then fetch events:

```bash
aws logs get-log-events --region "$AWS_REGION" \
  --log-group-name "/thonnas/{stackPrefix}-{component}-compose" \
  --log-stream-name "LOG_STREAM_NAME" \
  --limit 100
```

### Common Failure Points

| Symptom | Check | Typical Cause |
|--------|-------|---------------|
| Cloud-init fails early | `tail -200 /var/log/cloud-init-output.log` | yum/docker install, network, Secrets Manager |
| Git clone fails | Same log, look for `git clone` / `GIT_PASSWORD` | Bad credentials, secret name, or repo URL |
| Config resolve fails | Same log, look for `thonnas config resolve` | config resolve, secrets from AWS SM |
| Docker compose fails | Same log or `/var/log/compose-host/current.log` | Missing .env.thonnas, compose file path, image pull |
| Instance not in SSM | `aws ssm describe-instance-information --region "$AWS_REGION"` | Instance still booting, IAM/SSM agent issue |

### Re-run Cloud-Init (Manual Fix)

If user needs to re-run the user-data script (e.g. after fixing config):

```bash
aws ssm send-command --region "$AWS_REGION" \
  --instance-ids "i-INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo rm /var/lib/cloud/instances/*/sem/config_scripts_user 2>/dev/null; sudo cloud-init single --name scripts-user"]'
```

**Note:** User may prefer to do this via AWS Console → EC2 → Connect → Session Manager for interactive control.

## When AWS MCP Is Not Available

If `call_aws` is not available, provide the user with the exact AWS CLI commands above so they can run them locally. Document that they need:
- AWS credentials with EC2, SSM, and CloudWatch Logs permissions
- Instance ID (from EC2 console or `aws ec2 describe-instances`)
- Region (`AWS_REGION` of the compose-host stack)

