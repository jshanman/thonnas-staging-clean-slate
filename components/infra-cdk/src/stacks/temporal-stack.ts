import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { EcsSharedStack } from './ecs-shared-stack';
import { RdsStack } from './rds-stack';
import { ResolvedCloudComponent } from '../types';
import { extraNumber, omitEmptyLoadBalancers, rollingDeployment, serviceLogGroup } from './ecs-service-stack';
import { resolvePortableExtras } from '../release/portable-extras';
import { buildServiceLogGroupName } from '../utils/path-helpers';

export const TEMPORAL_AUTO_SETUP_IMAGE = 'temporalio/auto-setup:1.25.2';

export interface TemporalStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  networking: NetworkingStack;
  shared: EcsSharedStack;
  rds: RdsStack;
}

// @intent Run Temporal on shared Fargate with RDS secret fields, not a stub env
export class TemporalStack extends Stack {
  public readonly serviceName: string;

  // @intent The real, deployment-specific Cloud Map DNS name for this service -- undefined when
  // there is no default namespace (e.g. Fargate not enabled for this profile). Consumers must get
  // this from the construct directly (see TemporalToEcsStack), not guess it via a static
  // "{project}.{env}.internal" string in a module's own thonnas-config.json: the project-key
  // segment is only known at synth time (see EcsSharedStack's namespace naming), so any module that
  // hardcodes it breaks for every project not literally named the same as the hardcoded guess.
  public readonly internalEndpoint?: string;

  constructor(scope: Construct, id: string, props: TemporalStackProps) {
    super(scope, id, props);
    if (!props.shared.cluster) {
      throw new Error('Temporal requires an ECS cluster (managed-host / Fargate wiring).');
    }
    const privateSubnets = props.networking.privateSubnetSelection;
    if (!privateSubnets?.subnets?.length) {
      throw new Error(
        `TemporalStack requires private subnets (NAT) for env "${props.profile.envKey}". ` +
          'The worker must not use public subnets.',
      );
    }

    const extras = resolvePortableExtras({
      env: props.profile.envKey,
      extras: props.component.metadata.extras,
    });
    const serviceName = `${props.profile.envKey}-${props.component.component}`;
    this.serviceName = serviceName;

    const task = new ecs.FargateTaskDefinition(this, 'TemporalTask', {
      family: serviceName,
      cpu: extraNumber(extras, 'capacity.cpu') ?? 512,
      memoryLimitMiB: extraNumber(extras, 'capacity.memory') ?? 1024,
    });
    const postgresSecret = props.rds.secret;
    // @intent Host/port/dbname are not credentials -- inject them as plain env vars straight off
    // the RDS construct instead of round-tripping through Secrets Manager. Only username/password
    // are actual secrets. (Previously all five fields were sourced from the secret's attached
    // fields; that's an unnecessary secret dependency, not a security requirement.)
    task.addContainer('Temporal', {
      image: ecs.ContainerImage.fromRegistry(TEMPORAL_AUTO_SETUP_IMAGE),
      portMappings: [{ containerPort: 7233, name: 'temporal' }],
      environment: {
        DB: 'postgres12',
        THONNAS_ENV: props.profile.envKey,
        POSTGRES_SEEDS: props.rds.instance.instanceEndpoint.hostname,
        // @intent temporalio/auto-setup's wait_for_postgres()/schema-setup steps read DB_PORT,
        // not POSTGRES_PORT (POSTGRES_PORT is not a variable the script recognizes at all).
        // With only POSTGRES_PORT set, DB_PORT fell back to the script's hardcoded default of
        // 3306 (MySQL's port) -- so its readiness check (`nc -z $POSTGRES_SEEDS $DB_PORT`) was
        // silently probing the wrong port forever and never reaching real Postgres on 5432.
        // Confirmed via a live deploy: Postgres's own connection log showed zero incoming
        // attempts the entire time Temporal sat in "Waiting for PostgreSQL to startup."
        DB_PORT: props.rds.instance.instanceEndpoint.port.toString(),
        DBNAME: props.rds.databaseName,
        // @intent This RDS instance's parameter group enforces rds.force_ssl=1, rejecting any
        // unencrypted connection outright ("no pg_hba.conf entry ... no encryption"). Host
        // verification is disabled rather than bundling the RDS CA, matching the same
        // encrypt-but-don't-verify posture RelationalToEcsStack's THONNAS_RELATIONAL_TLS=true
        // already implies for every other Fargate peer's Postgres client on this private VPC.
        // POSTGRES_TLS_ENABLED covers the auto-setup CLI's own schema-setup connection; the
        // Temporal SERVER process reads its persistence config from a completely separate Go
        // template (docker/config_template.yaml) that recognizes SQL_TLS_ENABLED instead --
        // without it, schema setup succeeded (proving TLS+connectivity both worked) but the
        // server process still failed to boot ("no usable database connection found") because
        // its own datastore config silently defaulted SQL_TLS_ENABLED to false.
        POSTGRES_TLS_ENABLED: 'true',
        POSTGRES_TLS_DISABLE_HOST_VERIFICATION: 'true',
        SQL_TLS_ENABLED: 'true',
      },
      secrets: {
        POSTGRES_USER: ecs.Secret.fromSecretsManager(postgresSecret, 'username'),
        POSTGRES_PWD: ecs.Secret.fromSecretsManager(postgresSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'temporal',
        logGroup: serviceLogGroup(
          this,
          'LogGroup',
          // @intent Include stackPrefix so multi-project staging does not collide
          buildServiceLogGroupName(props.profile.stackPrefix, props.component.component),
          extras,
        ),
      }),
    });
    postgresSecret.grantRead(task.taskRole);
    const sg = new ec2.SecurityGroup(this, 'TemporalSg', {
      vpc: props.networking.vpc,
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.ipv4(props.networking.vpc.vpcCidrBlock), ec2.Port.tcp(7233), 'Temporal frontend');
    // @intent Add 5432 from this SG onto the RDS group in this stack to avoid a cycle
    new ec2.CfnSecurityGroupIngress(this, 'RdsFromTemporal', {
      groupId: props.rds.dbSecurityGroup.securityGroupId,
      sourceSecurityGroupId: sg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Postgres from Temporal task',
    });
    const rolling = rollingDeployment(extras);
    // @intent Register via classic ECS Service Discovery (Cloud Map A-records pointing at each
    // task's real ENI IP), NOT Service Connect, so consumers (e.g. api-go's Temporal client) can
    // reach this service by a stable internal DNS name. Confirmed via a live deploy: Service
    // Connect's DNS answer for this alias was IPv6-only (an AAAA record with no A record at all)
    // in this VPC, which has no IPv6 CIDR block associated -- the address was unreachable from
    // inside any task (only link-local IPv6 exists on task ENIs), so api-go's Temporal client
    // could never actually connect regardless of client-side dial configuration. Classic Service
    // Discovery only emits A-records when the subnet has no IPv6, which is exactly this VPC.
    // Before Service Connect was tried at all, this hostname resolved to nothing (no DNS record
    // whatsoever) since nothing registered it -- so some registration mechanism is required; it
    // just can't be Service Connect for this specific link.
    const namespace = props.shared.cluster.defaultCloudMapNamespace;
    const worker = new ecs.FargateService(this, 'TemporalService', {
      cluster: props.shared.cluster,
      taskDefinition: task,
      desiredCount: 1,
      serviceName,
      assignPublicIp: false,
      securityGroups: [sg],
      vpcSubnets: privateSubnets,
      minHealthyPercent: rolling.minHealthyPercent,
      maxHealthyPercent: rolling.maxHealthyPercent,
      circuitBreaker: rolling.circuitBreaker,
      // @intent Enable ECS Exec for direct diagnosis (see ecs-service-stack.ts for rationale).
      enableExecuteCommand: true,
      ...(namespace
        ? {
            cloudMapOptions: {
              cloudMapNamespace: namespace,
              name: props.component.component,
              dnsRecordType: servicediscovery.DnsRecordType.A,
            },
          }
        : {}),
    });
    omitEmptyLoadBalancers(worker);
    if (namespace) {
      this.internalEndpoint = `${props.component.component}.${namespace.namespaceName}:7233`;
    }
    // @intent Do NOT tag this service (or its auto-created Cloud Map Service) "AmazonECSManaged".
    // That tag is what grants the ECS service-linked role DeleteService on a Cloud Map service;
    // confirmed via CloudTrail that ECS's task-set cleanup then deleted this CloudFormation-owned
    // registry out from under the live ECS service, leaving it unable to launch any task.
    new CfnOutput(this, 'ServiceName', { value: serviceName });
    new CfnOutput(this, 'PostgresSecretArn', { value: postgresSecret.secretArn });
    if (this.internalEndpoint) {
      new CfnOutput(this, 'InternalEndpoint', { value: this.internalEndpoint });
    }
  }
}




