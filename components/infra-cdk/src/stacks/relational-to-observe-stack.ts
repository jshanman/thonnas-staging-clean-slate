import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { RdsStack } from './rds-stack';
import { ObserveStack } from './observe-stack';

export interface RelationalToObserveStackProps extends StackProps {
  profile: EnvProfile;
  networking: NetworkingStack;
  rds: RdsStack;
  observe: ObserveStack;
}

// @intent Edge: open Postgres from dashboard + inject portable SQLSTORE env (no vendor keys)
export class RelationalToObserveStack extends Stack {
  constructor(scope: Construct, id: string, props: RelationalToObserveStackProps) {
    super(scope, id, props);

    const secret = props.rds.instance.secret;
    if (!secret) {
      throw new Error('RelationalToObserve requires an RDS-generated Secrets Manager secret.');
    }
    if (!props.observe.dashboardTaskDefinition || !props.observe.dashboardSecurityGroup) {
      return;
    }

    // @intent Allow dashboard tasks to reach Postgres on 5432
    new CfnSecurityGroupIngress(this, 'DashboardToPostgres5432', {
      groupId: props.rds.dbSecurityGroup.securityGroupId,
      sourceSecurityGroupId: props.observe.dashboardSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Postgres from observe dashboard',
    });

    const task = props.observe.dashboardTaskDefinition;
    const container = task.defaultContainer;
    if (!container) return;

    // @intent Portable metastore contract; package hook maps to product DSN
    // DB name is package-owned (thonnas-db.json / boot default), not RDS secret.dbname
    container.addEnvironment('THONNAS_DASHBOARD_SQLSTORE', 'postgres');
    container.addSecret('THONNAS_DASHBOARD_PG_HOST', ecs.Secret.fromSecretsManager(secret, 'host'));
    container.addSecret('THONNAS_DASHBOARD_PG_PORT', ecs.Secret.fromSecretsManager(secret, 'port'));
    container.addSecret('THONNAS_DASHBOARD_PG_USER', ecs.Secret.fromSecretsManager(secret, 'username'));
    container.addSecret('THONNAS_DASHBOARD_PG_PASSWORD', ecs.Secret.fromSecretsManager(secret, 'password'));
    secret.grantRead(task.obtainExecutionRole());
  }
}



