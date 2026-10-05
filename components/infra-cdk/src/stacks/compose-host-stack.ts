import * as crypto from 'node:crypto';
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { PublishedComposeService, ResolvedCloudComponent } from '../types';
import { DEFAULT_GIT_PASSWORD_SECRET_NAME } from '../utils/root-domain';

/** ALB name max 32 chars; unique per account/region. Derive from stack name so multi-branch deploys do not collide. */
function composeHostAlbNameFromStack(stackName: string): string {
  const base = stackName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase().replace(/^-|-$/g, '');
  const prefix = base.slice(0, 20);
  return prefix ? `${prefix}-compose-alb` : 'compose-alb';
}

export interface ComposeHostConfig {
  gitRepositoryUrl: string;
  branch: string;
  tag?: string;
  composeFile: string;
  workingDirectory: string;
  publishedServices: PublishedComposeService[];
  hostedZoneId?: string;
  hostedZoneName?: string;
  rootDomain?: string;
  gitPasswordSecretName?: string;
  gitUsername?: string;
  /** When set, ALB terminates HTTPS (443) and forwards to EC2:80; Route53 points to ALB. Requires ACM cert (e.g. for *.rootDomain). */
  certificateArn?: string;
  /** S3 bucket names for infra.storage; created by stack unless ThonnasBucketExists:name context is true (reuse). */
  s3StorageBucketNames?: string[];
  /** SNS+SQS domain-event bus names; IAM on the compose-host instance role. */
  eventsBus?: {
    topicName: string;
    queueNames: string[];
    dlqNames: string[];
    queues?: Array<{ consumerId: string; queueName: string }>;
  };
  /** Pre-validated deploy slug (--deploy-slug); set as THONNAS_DEPLOY_SLUG for `{deploy-slug}` in bucket/host templates on EC2. */
  deploySlug?: string;
}

export interface ComposeHostStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  networking: NetworkingStack;
  config: ComposeHostConfig;
}

export interface ComposeHostUserDataOptions {
  workingDirectory: string;
  gitRepositoryUrl: string;
  composeFile: string;
  tag: string;
  envFileLines: string[];
  gitPasswordSecretName: string;
  gitUsername?: string;
  /** Thonnas env (e.g. beta); when set, user-data only provisions + clones (see buildComposeHostUserData) — release-beta.sh does everything app-level, both on first boot and every release after. When unset, falls back to the legacy raw docker-compose-up path below. */
  thonnasEnv?: string;
  /** AWS region; currently unused by the thonnasEnv path (release-beta.sh's caller sets AWS_REGION itself) but still consumed by the legacy non-thonnasEnv path below. */
  region?: string;
  /** When set, user-data stream is sent to this CloudWatch log group (stream: user-data) for monitoring progress */
  cloudWatchLogGroupName?: string;
}

export const buildComposeHostUserData = (options: ComposeHostUserDataOptions): string[] => {
  const composePluginPath = '/usr/libexec/docker/cli-plugins/docker-compose';
  const logDir = '/var/log/compose-host';
  const logMarker = `${logDir}/$(date +%Y%m%dT%H%M%S)-run.log`;
  const currentLog = `${logDir}/current.log`;
  const commands: string[] = [
    '# compose-host user-data (force replace when instance terminated outside CF); replace-v6',
    `LOG_DIR=${logDir}`,
    `LOG_MARKER=${logMarker}`,
    `CURRENT_LOG=${currentLog}`,
    'mkdir -p "$LOG_DIR"',
    'touch "$LOG_MARKER"',
    'chmod 600 "$LOG_DIR"',
    'chmod 600 "$LOG_MARKER"',
    'ln -sf "$LOG_MARKER" "$CURRENT_LOG"',
    'exec > >(tee -a "$LOG_MARKER") 2>&1',
    'set -euo pipefail',
    'log() { echo "[compose-host] $(date --iso-8601=seconds) $*"; }',
    'log "Starting compose host user-data execution"',
    ...(options.cloudWatchLogGroupName
      ? (() => {
          const cwConfig = {
            agent: { run_as_user: 'root' },
            logs: {
              logs_collected: {
                files: {
                  collect_list: [
                    {
                      file_path: '/var/log/compose-host/current.log',
                      log_group_name: options.cloudWatchLogGroupName,
                      log_stream_name: 'user-data',
                    },
                  ],
                },
              },
            },
          };
          const cwConfigB64 = Buffer.from(JSON.stringify(cwConfig)).toString('base64');
          return [
            'log "Installing CloudWatch agent to stream user-data to CloudWatch Logs"',
            'yum install -y amazon-cloudwatch-agent 2>/dev/null || log "CloudWatch agent install skipped (optional)"',
            `mkdir -p /opt/aws/amazon-cloudwatch-agent/etc`,
            `echo '${cwConfigB64}' | base64 -d > /opt/aws/amazon-cloudwatch-agent/etc/user-data-cw-config.json 2>/dev/null || true`,
            '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a start -c file:/opt/aws/amazon-cloudwatch-agent/etc/user-data-cw-config.json -s 2>/dev/null || true',
            'log "CloudWatch agent started (view log stream user-data in log group for live progress)"',
          ];
        })()
      : []),
    'log "Updating base packages"',
    'yum update -y',
    'log "Installing docker/git/awscli/python3"',
    'yum install -y docker git awscli python3',
    '# @intent Install Node.js 22 so Thonnas CLI install script succeeds (requires v22+); AL2023 default nodejs is v18',
    'log "Installing Node.js 22 (Thonnas CLI requires v22+)"',
    'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
    'yum install -y nodejs',
    'log "Node version: $(node -v)"',
    // @intent Report readiness (or failure) to the CreationPolicy resource signal on the instance
    // resource, so CloudFormation -- and therefore `infra apply` -- does not report success until
    // user-data has actually finished, not just launched. Placed after aws/curl are confirmed
    // installed above; an earlier yum failure falls back to CFN's existing timeout behavior,
    // unchanged from before this signal existed. Resolves the stack name/logical id from the
    // instance's own CloudFormation-assigned tags rather than baking them in, since the logical
    // id is itself derived from a hash of this user-data content -- baking it in would be circular.
    // Resolution happens lazily inside signal_cfn (not here), with retries: CloudFormation applies
    // those tags via its own ec2:CreateTags call, which is not ordered against user-data start, so
    // they may not exist yet this early in boot.
    // @intent IMDSv2 (token-required) is the account default for new instances in some orgs even
    // when the CDK construct does not explicitly request it -- a bare v1-style curl gets a silent
    // 401 (empty body, not a hang) and every downstream value resolves empty. Always fetch a token
    // first; this works whether the instance is IMDSv1- or IMDSv2-only.
    'IMDS_TOKEN=$(curl -s --max-time 3 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token || echo "")',
    `AWS_REGION=${options.region ?? ''}`,
    'if [ -z "$AWS_REGION" ]; then AWS_REGION=$(curl -s --max-time 3 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region || echo ""); fi',
    'CFN_INSTANCE_ID=$(curl -s --max-time 3 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id || echo "")',
    'CFN_SIGNALED=0',
    'resolve_cfn_tag() {',
    '  local tag_key="$1"',
    '  local attempt=0',
    '  local value=""',
    '  while [ "$attempt" -lt 10 ]; do',
    '    value=$(aws ec2 describe-tags --region "$AWS_REGION" --filters "Name=resource-id,Values=$CFN_INSTANCE_ID" "Name=key,Values=$tag_key" --query "Tags[0].Value" --output text 2>/dev/null || echo "")',
    '    if [ -n "$value" ] && [ "$value" != "None" ]; then',
    '      echo "$value"',
    '      return 0',
    '    fi',
    '    attempt=$((attempt + 1))',
    '    sleep 3',
    '  done',
    '  echo ""',
    '}',
    'signal_cfn() {',
    '  local status="$1"',
    '  if [ "$CFN_SIGNALED" = "1" ]; then return 0; fi',
    '  CFN_SIGNALED=1',
    '  if [ -z "$CFN_INSTANCE_ID" ] || [ -z "$AWS_REGION" ]; then',
    '    log "Skipping CloudFormation signal ($status): instance id/region not available"',
    '    return 0',
    '  fi',
    '  local stack_name; stack_name=$(resolve_cfn_tag "aws:cloudformation:stack-name")',
    '  local logical_id; logical_id=$(resolve_cfn_tag "aws:cloudformation:logical-id")',
    '  if [ -z "$stack_name" ] || [ -z "$logical_id" ]; then',
    '    log "Skipping CloudFormation signal ($status): stack/logical-id tags never appeared"',
    '    return 0',
    '  fi',
    '  log "Signaling CloudFormation resource $logical_id: $status"',
    '  aws cloudformation signal-resource --region "$AWS_REGION" --stack-name "$stack_name" --logical-resource-id "$logical_id" --unique-id "$CFN_INSTANCE_ID" --status "$status" || log "Failed to send CloudFormation signal"',
    '}',
    'on_exit() {',
    '  local exit_code=$?',
    '  if [ "$exit_code" = "0" ]; then signal_cfn SUCCESS; else signal_cfn FAILURE; fi',
    '}',
    'trap on_exit EXIT',
    'if [ "${SKIP_DOCKER_CMDS:-false}" != "true" ]; then',
    '  log "Enabling docker service"',
    '  systemctl enable docker',
    '  systemctl start docker',
    'fi',
    'log "Installing docker compose plugin v2.27.0"',
    'mkdir -p /usr/libexec/docker/cli-plugins',
    `curl -L "https://github.com/docker/compose/releases/download/v2.27.0/docker-compose-linux-x86_64" -o ${composePluginPath}`,
    `chmod +x ${composePluginPath}`,
    'log "docker compose version: $(docker compose version 2>/dev/null || echo unavailable)"',
    `export REPO_DIR=${options.workingDirectory}`,
    `export REPO_URL=${options.gitRepositoryUrl}`,
    `export GIT_CLONE_USERNAME=${options.gitUsername ?? 'git'}`,
    'log "Working directory: ${REPO_DIR}"',
    'log "Git repository: ${REPO_URL}"',
    'log "Git clone username: ${GIT_CLONE_USERNAME}"',
    'rm -rf "$REPO_DIR"',
    '# @intent Fetch git password from AWS Secrets Manager when not provided explicitly',
    `GIT_SECRET_NAME=${options.gitPasswordSecretName}`,
    'log "Using git password secret: ${GIT_SECRET_NAME}"',
    'if [ -z "${GIT_PASSWORD:-}" ]; then',
    '  if ! command -v aws >/dev/null 2>&1; then',
    '    log "aws CLI not available and GIT_PASSWORD not set"; exit 1;',
    '  fi',
    '  GIT_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "$GIT_SECRET_NAME" --query SecretString --output text)',
    '  log "Fetched git password from Secrets Manager (length: ${#GIT_PASSWORD})"',
    'else',
    '  log "Using provided git password from environment"',
    'fi',
    'export GIT_PASSWORD',
    'if [ -z "$GIT_PASSWORD" ] || [ "$GIT_PASSWORD" = "None" ]; then log "Failed to fetch git password"; exit 1; fi',
    'CLONE_URL=$(python3 - <<\'PY\'',
    'import os',
    'import sys',
    'from urllib.parse import urlparse, urlunparse',
    'url = os.environ.get("REPO_URL")',
    'password = os.environ.get("GIT_PASSWORD", "")',
    'if not url:',
    '    raise SystemExit("Missing git repo url")',
    'parts = list(urlparse(url))',
    'scheme = parts[0].lower()',
    'if scheme not in ("http", "https") or not parts[1]:',
    '    print(url)',
    '    sys.exit(0)',
    'username = os.environ.get("GIT_CLONE_USERNAME", "git")',
    'if "@" in parts[1]:',
    '    userinfo, host = parts[1].split("@", 1)',
    '    if ":" in userinfo:',
    '        username = userinfo.split(":", 1)[0] or username',
    '    elif userinfo:',
    '        username = userinfo',
    '    parts[1] = host',
    'host = parts[1]',
    'parts[1] = f"{username}:{password}@{host}"',
    'print(urlunparse(parts))',
    'PY',
    ')',
    // @intent Never log CLONE_URL directly — it embeds the git password. Mask it for display only.
    'CLONE_URL_DISPLAY=$(printf "%s" "$CLONE_URL" | sed -E "s#(://[^:/@]+):[^@]*@#\\1:***@#")',
    'log "Cloning repository from $CLONE_URL_DISPLAY"',
    'git clone "$CLONE_URL" "$REPO_DIR"',
    'log "Repository cloned to $REPO_DIR"',
    `cd "$REPO_DIR" && git checkout ${options.tag} && log "Checked out ${options.tag}"`,
  ];

  if (options.thonnasEnv) {
    // @intent Provisioning stops here on purpose: install docker/git/checkout the repo, nothing
    // app-level. Getting the app running (CLI install, lib ci, setup, config, build, start) is
    // entirely release.sh's job — the SAME script whether this is the very first run after infra
    // apply or the Nth release later, so there is exactly one place that sequence is maintained.
    // See components/infra-cdk/scripts/release-beta.sh.
    commands.push('log "Provisioning complete; run thonnas release (release-beta.sh) to bring the app up"');
  } else {
    commands.push(
      'log "Writing env file to $REPO_DIR/.env.thonnas"',
      'cat <<"EOF" > "$REPO_DIR/.env.thonnas"',
      ...options.envFileLines,
      'EOF',
    );
    commands.push(
      'if [ "${SKIP_DOCKER_CMDS:-false}" != "true" ]; then',
      '  log "Running docker compose pull"',
      `  cd "$REPO_DIR" && docker compose --env-file "$REPO_DIR/.env.thonnas" -f ${options.composeFile} pull`,
      '  log "Running docker compose up -d"',
      `  cd "$REPO_DIR" && docker compose --env-file "$REPO_DIR/.env.thonnas" -f ${options.composeFile} up -d`,
      '  log "docker compose commands completed"',
      'else',
      '  log "SKIP_DOCKER_CMDS=true, skipping docker compose commands"',
      'fi',
      'log "Compose host user-data completed successfully"',
    );
  }

  return commands;
};

// @intent Provision single EC2 that clones repo + runs docker compose for entire stack
export class ComposeHostStack extends Stack {
  constructor(scope: Construct, id: string, props: ComposeHostStackProps) {
    super(scope, id, props);

    // @intent Secret ID follows Thonnas convention: componentKey/env/secretName
    const rawSecretName =
      props.config.gitPasswordSecretName?.trim() || DEFAULT_GIT_PASSWORD_SECRET_NAME;
    const gitPasswordSecretId =
      rawSecretName.includes('/') ? rawSecretName : `infra-cdk/${props.profile.envKey}/${rawSecretName}`;

    const securityGroup = new ec2.SecurityGroup(this, 'ComposeSecurityGroup', {
      vpc: props.networking.vpc,
      allowAllOutbound: true,
      securityGroupName: `${props.profile.stackPrefix}-${props.component.component}-compose-sg`,
    });

    // @intent Only use ALB/HTTPS when at least one published service has external endpoint with https and 443 (from component thonnas-infra)
    const hasHttps443 = props.config.publishedServices.some(
      (s) => s.protocol === 'https' && s.port === 443,
    );
    const useAlb = Boolean(props.config.certificateArn && hasHttps443);
    if (useAlb) {
      // @intent When ALB is used, only allow traffic from ALB (ALB SG added below after ALB is created)
      // Placeholder: we will add the ALB SG ingress after creating the ALB
    } else {
      // @intent Reverse proxy on 80; no ALB, so allow public HTTP
      securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        'Allow reverse proxy HTTP',
      );
    }

    const role = new iam.Role(this, 'ComposeRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          // Git password + component secrets (componentKey/env/secretName)
          `arn:aws:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:*`,
        ],
      }),
    );
    // @intent Let user-data report readiness (or failure) back to the CreationPolicy resource
    // signal below, so `infra apply` doesn't report success until this instance is actually
    // ready for `thonnas release` (release-beta.sh) to act on it -- not just "launched".
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:SignalResource'],
        resources: [Stack.of(this).stackId],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeTags'],
        resources: ['*'],
      }),
    );

    // @intent Create or import S3 buckets for infra.storage; HeadBucket sets ThonnasBucketExists (infra-provider)
    const bucketNames = props.config.s3StorageBucketNames ?? [];
    for (let i = 0; i < bucketNames.length; i++) {
      const name = bucketNames[i];
      const bucketExistsKey = `ThonnasBucketExists:${name}`;
      const bucketExistsInAws = this.node.tryGetContext(bucketExistsKey) === 'true';
      const bucket = bucketExistsInAws
        ? s3.Bucket.fromBucketName(this, `StorageBucket${i}`, name)
        : new s3.Bucket(this, `StorageBucket${i}`, {
            bucketName: name,
            removalPolicy: RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
          });
      bucket.grantReadWrite(role);
    }

    const eventsBus = props.config.eventsBus;
    if (eventsBus?.topicName) {
      const account = Stack.of(this).account;
      const region = Stack.of(this).region;
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sns:Publish'],
          resources: [`arn:aws:sns:${region}:${account}:${eventsBus.topicName}`],
        }),
      );
      const queueNames = [...(eventsBus.queueNames ?? []), ...(eventsBus.dlqNames ?? [])].filter(Boolean);
      if (queueNames.length > 0) {
        role.addToPolicy(
          new iam.PolicyStatement({
            actions: [
              'sqs:ReceiveMessage',
              'sqs:DeleteMessage',
              'sqs:GetQueueUrl',
              'sqs:GetQueueAttributes',
              'sqs:ChangeMessageVisibility',
              'sqs:ChangeMessageVisibilityBatch',
            ],
            resources: queueNames.map((name) => `arn:aws:sqs:${region}:${account}:${name}`),
          }),
        );
      }
    }

    // @intent Build user-data before instance so we can hash it; logical ID derived from hash forces CF to replace EC2 when config/user-data changes. Log group name must be unique per account/region (include stackPrefix for multi-branch).
    const composeLogGroupName = `/thonnas/${props.profile.stackPrefix}-${props.component.component}-compose`;
    const envFileLines = this.buildEnvFileLines(props);
    const tag = props.config.tag ?? props.config.branch ?? 'main';
    const userData = buildComposeHostUserData({
      workingDirectory: props.config.workingDirectory,
      gitRepositoryUrl: props.config.gitRepositoryUrl,
      composeFile: props.config.composeFile,
      tag,
      envFileLines,
      gitPasswordSecretName: gitPasswordSecretId,
      gitUsername: props.config.gitUsername,
      thonnasEnv: props.profile.envKey,
      region: this.region,
      cloudWatchLogGroupName: composeLogGroupName,
    });
    const contentHash = crypto.createHash('sha256').update(userData.join('\n')).digest('hex').slice(0, 8);
    const instanceLogicalId = `ComposeInstance${contentHash}`;

    const instance = new ec2.Instance(this, instanceLogicalId, {
      vpc: props.networking.vpc,
      vpcSubnets: props.networking.publicSubnetSelection,
      securityGroup,
      role,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceName: `${props.profile.stackPrefix}-${props.component.component}-compose`,
      // @intent Provide larger root disk so docker layers do not exhaust default 8GB
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(50, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    // @intent Without this, CloudFormation (and therefore `infra apply`) reports CREATE_COMPLETE
    // as soon as the instance launches, not once user-data has actually finished provisioning it
    // (docker/node install, git clone). A `thonnas release` immediately after a first-ever
    // `infra apply` would then race a still-booting instance. The matching signal call is the
    // last thing user-data does (success or failure) -- see buildComposeHostUserData.
    instance.instance.cfnOptions.creationPolicy = {
      resourceSignal: {
        count: 1,
        timeout: 'PT15M',
      },
    };

    const logGroup = new logs.LogGroup(this, 'ComposeLogGroup', {
      logGroupName: composeLogGroupName,
      retention: logs.RetentionDays.ONE_MONTH,
      // @intent Ensure stack destroy deletes shared log group to avoid leftovers
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const eip = new ec2.CfnEIP(this, 'ComposeEip', { domain: 'vpc' });
    new ec2.CfnEIPAssociation(this, 'ComposeEipAssociation', {
      eip: eip.ref,
      instanceId: instance.instanceId,
    });

    let alb: elbv2.ApplicationLoadBalancer | undefined;
    if (useAlb && props.config.certificateArn) {
      const albSg = new ec2.SecurityGroup(this, 'ComposeAlbSg', {
        vpc: props.networking.vpc,
        allowAllOutbound: true,
        securityGroupName: `${props.profile.stackPrefix}-${props.component.component}-compose-alb-sg`,
      });
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS');
      securityGroup.addIngressRule(albSg, ec2.Port.tcp(80), 'Allow ALB to reverse proxy');

      alb = new elbv2.ApplicationLoadBalancer(this, 'ComposeAlb', {
        vpc: props.networking.vpc,
        internetFacing: true,
        securityGroup: albSg,
        loadBalancerName: composeHostAlbNameFromStack(this.stackName),
        vpcSubnets: props.networking.publicSubnetSelection,
      });

      const cert = acm.Certificate.fromCertificateArn(this, 'ComposeCert', props.config.certificateArn);
      const tg = new elbv2.ApplicationTargetGroup(this, 'ComposeTg', {
        vpc: props.networking.vpc,
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.INSTANCE,
        targets: [new elbv2Targets.InstanceIdTarget(instance.instanceId, 80)],
      });
      alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [cert],
        defaultTargetGroups: [tg],
      });
      alb.addListener('HttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
    }

    instance.userData.addCommands(...userData);

    // @intent Zone must be set by plan (ensureComposeHostHostedZone) so A records are created in the correct hosted zone
    const zone = this.resolveHostedZone(props.config);
    if (zone) {
      const usedRecordIds = new Set<string>();
      for (const service of props.config.publishedServices) {
        let recordId = this.toRoute53RecordId(service.name);
        let suffix = 0;
        while (usedRecordIds.has(recordId)) {
          recordId = `${this.toRoute53RecordId(service.name)}${++suffix}`;
        }
        usedRecordIds.add(recordId);
        const recordName = this.toRecordName(service.hostname, zone.zoneName);
        if (alb) {
          new route53.ARecord(this, recordId, {
            zone,
            recordName,
            target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
          });
        } else {
          new route53.ARecord(this, recordId, {
            zone,
            recordName,
            target: route53.RecordTarget.fromIpAddresses(eip.attrPublicIp),
          });
        }
      }
    }

    logGroup.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [role],
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      }),
    );
  }

  private buildEnvFileLines(props: ComposeHostStackProps): string[] {
    const envLines = [`THONNAS_ENV=${props.profile.envKey}`];
    // @intent Script URL: used by user-data for "curl | sh" to fetch the install script (not the artifact)
    const scriptUrl = process.env.THONNAS_INSTALL_SCRIPT_URL?.trim();
    if (scriptUrl) {
      envLines.push(`THONNAS_INSTALL_SCRIPT_URL=${scriptUrl}`);
    }
    // @intent Artifact base: install script builds tarball URL from this. Do not set THONNAS_INSTALL_URL to the script URL or the script will try to extract it as a tarball.
    const baseUrl = process.env.THONNAS_INSTALL_BASE_URL?.trim();
    if (baseUrl) {
      envLines.push(`THONNAS_INSTALL_BASE_URL=${baseUrl}`);
    }
    const services = props.config.publishedServices ?? [];
    // @intent e2e-build uses THONNAS_ROOT_DOMAIN to generate nginx-ready routes file (literal hostnames)
    if (props.config.rootDomain) {
      envLines.push(`THONNAS_ROOT_DOMAIN=${props.config.rootDomain}`);
    }
    // @intent Deploy slug from infra plan/apply (--deploy-slug); used by build scripts to resolve `{deploy-slug}` bucket templates when resolved-storage-buckets.json is missing
    if (props.config.deploySlug) {
      envLines.push(`THONNAS_DEPLOY_SLUG=${props.config.deploySlug}`);
    }
    const eventsBus = props.config.eventsBus;
    if (eventsBus?.topicName) {
      const account = Stack.of(this).account;
      const region = Stack.of(this).region;
      envLines.push(`QUEUE_SNS_REGION=${region}`);
      envLines.push(`QUEUE_SNS_ACCOUNT_ID=${account}`);
      envLines.push(`QUEUE_SNS_TOPIC_ARN=arn:aws:sns:${region}:${account}:${eventsBus.topicName}`);
      const queueUrlMap: Record<string, string> = {};
      for (const queue of eventsBus.queues ?? []) {
        queueUrlMap[queue.consumerId] = `https://sqs.${region}.amazonaws.com/${account}/${queue.queueName}`;
      }
      if (Object.keys(queueUrlMap).length === 0) {
        for (const queueName of eventsBus.queueNames ?? []) {
          const marker = '-thonnas-';
          const idx = queueName.indexOf(marker);
          const consumerId = idx >= 0 ? queueName.slice(idx + marker.length) : queueName;
          queueUrlMap[consumerId] = `https://sqs.${region}.amazonaws.com/${account}/${queueName}`;
        }
      }
      envLines.push(`QUEUE_SNS_QUEUE_URL_MAP=${JSON.stringify(queueUrlMap)}`);
    }
    services.forEach((service) => {
      const hostVarName = this.formatEnvVarName(service.name);
      envLines.push(`${hostVarName}=${service.hostname}`);
      // @intent Reverse-proxy reads _EXTERNAL_HOST per service for nginx server_name; same hostname as public URL
      const externalHostVarName = this.formatExternalHostEnvVarName(service.name);
      envLines.push(`${externalHostVarName}=${service.hostname}`);
    });
    return envLines;
  }

  private formatEnvVarName(serviceName: string): string {
    return `${serviceName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_HOST`;
  }

  /** @intent Match derivation names used by reverse-proxy (e.g. API_EXTERNAL_HOST from service name api) */
  private formatExternalHostEnvVarName(serviceName: string): string {
    return `${serviceName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_EXTERNAL_HOST`;
  }

  /** @intent Stable logical ID per service so adding/removing services does not reassign indices and break Route53 updates */
  private toRoute53RecordId(serviceName: string): string {
    const sanitized = serviceName.replace(/[^A-Za-z0-9]/g, '');
    return `ComposeRecord${sanitized || 'Default'}`;
  }

  private toRecordName(hostname: string, zoneName: string): string {
    const normalizedZone = zoneName.endsWith('.') ? zoneName.slice(0, -1) : zoneName;
    if (hostname.endsWith(`.${normalizedZone}`)) {
      return hostname.slice(0, hostname.length - normalizedZone.length - 1);
    }
    return hostname;
  }

  private resolveHostedZone(config: ComposeHostConfig): route53.IHostedZone | undefined {
    if (!config.hostedZoneId || !config.hostedZoneName) {
      return undefined;
    }

    return route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    });
  }
}


