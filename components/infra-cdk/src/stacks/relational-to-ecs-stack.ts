import { Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { RdsStack } from './rds-stack';
import { containerHasName, rememberContainerName } from './container-names';

export interface RelationalToEcsPeer {
  taskDefinition: ecs.FargateTaskDefinition;
  serviceSecurityGroupExportName: string;
}

export interface RelationalToEcsStackProps extends StackProps {
  profile: EnvProfile;
  networking: NetworkingStack;
  rds: RdsStack;
  ecsPeers: RelationalToEcsPeer[];
}

// @intent Edge: open RDS from Fargate + inject portable SM secrets (no RDS→ECS cycle)
export class RelationalToEcsStack extends Stack {
  constructor(scope: Construct, id: string, props: RelationalToEcsStackProps) {
    super(scope, id, props);

    const secret = props.rds.secret;
    if (!props.ecsPeers.length) return;

    // @intent Peer SG ingress lives on the edge so RdsStack does not depend on Fargate
    props.ecsPeers.forEach((peer, index) => {
      new CfnSecurityGroupIngress(this, `EcsToRds5432${index}`, {
        groupId: props.rds.dbSecurityGroup.securityGroupId,
        sourceSecurityGroupId: Fn.importValue(peer.serviceSecurityGroupExportName),
        ipProtocol: 'tcp',
        fromPort: 5432,
        toPort: 5432,
        description: 'Postgres from managed-host Fargate',
      });
    });

    for (const peer of props.ecsPeers) {
      const container = peer.taskDefinition.defaultContainer;
      if (!container) continue;
      // @intent Portable contract; packages map THONNAS_RELATIONAL_* → product env
      const addEnv = (name: string, value: string) => {
        if (containerHasName(container, name)) return;
        container.addEnvironment(name, value);
        rememberContainerName(container, name);
      };
      const addSecret = (name: string, field: string) => {
        if (containerHasName(container, name)) return;
        container.addSecret(name, ecs.Secret.fromSecretsManager(secret, field));
        rememberContainerName(container, name);
      };
      addEnv('THONNAS_RELATIONAL_TLS', 'true');
      addEnv('THONNAS_RELATIONAL_SECRET_ARN', props.rds.secretArn);
      // @intent Host/port are not credentials -- inject them as plain env vars off the RDS
      // construct instead of round-tripping through Secrets Manager (only username/password
      // are actual secrets).
      addEnv('THONNAS_RELATIONAL_HOST', props.rds.instance.instanceEndpoint.hostname);
      addEnv('THONNAS_RELATIONAL_PORT', props.rds.instance.instanceEndpoint.port.toString());
      addSecret('THONNAS_RELATIONAL_USERNAME', 'username');
      addSecret('THONNAS_RELATIONAL_PASSWORD', 'password');
      secret.grantRead(peer.taskDefinition.obtainExecutionRole());
    }
  }
}




