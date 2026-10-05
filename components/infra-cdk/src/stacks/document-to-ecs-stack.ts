import { Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { DocDbStack } from './docdb-stack';
import { containerHasName, rememberContainerName } from './container-names';

export interface DocumentToEcsPeer {
  taskDefinition: ecs.FargateTaskDefinition;
  serviceSecurityGroupExportName: string;
}

export interface DocumentToEcsStackProps extends StackProps {
  profile: EnvProfile;
  networking: NetworkingStack;
  docdb: DocDbStack;
  ecsPeers: DocumentToEcsPeer[];
}

// @intent Edge: open DocDB from Fargate + inject portable SM secrets (no DocDB→ECS cycle)
export class DocumentToEcsStack extends Stack {
  constructor(scope: Construct, id: string, props: DocumentToEcsStackProps) {
    super(scope, id, props);

    const secret = props.docdb.secret;
    if (!props.ecsPeers.length) return;

    // @intent Peer SG ingress lives on the edge so DocDbStack does not depend on Fargate
    props.ecsPeers.forEach((peer, index) => {
      new CfnSecurityGroupIngress(this, `EcsToDocDb27017${index}`, {
        groupId: props.docdb.dbSecurityGroup.securityGroupId,
        sourceSecurityGroupId: Fn.importValue(peer.serviceSecurityGroupExportName),
        ipProtocol: 'tcp',
        fromPort: 27017,
        toPort: 27017,
        description: 'DocumentDB from managed-host Fargate',
      });
    });

    for (const peer of props.ecsPeers) {
      const container = peer.taskDefinition.defaultContainer;
      if (!container) continue;
      // @intent Portable contract; packages map THONNAS_DOCUMENT_* → product env
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
      addEnv('THONNAS_DOCUMENT_TLS', 'true');
      addEnv('THONNAS_DOCUMENT_SECRET_ARN', props.docdb.secretArn);
      addSecret('THONNAS_DOCUMENT_HOST', 'host');
      addSecret('THONNAS_DOCUMENT_PORT', 'port');
      addSecret('THONNAS_DOCUMENT_USERNAME', 'username');
      addSecret('THONNAS_DOCUMENT_PASSWORD', 'password');
      secret.grantRead(peer.taskDefinition.obtainExecutionRole());
    }
  }
}



