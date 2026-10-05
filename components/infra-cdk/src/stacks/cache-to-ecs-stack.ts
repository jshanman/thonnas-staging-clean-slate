import { Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { RedisStack } from './redis-stack';
import { containerHasName, rememberContainerName } from './container-names';

export interface CacheToEcsPeer {
  taskDefinition: ecs.FargateTaskDefinition;
  serviceSecurityGroupExportName: string;
}

export interface CacheToEcsStackProps extends StackProps {
  profile: EnvProfile;
  networking: NetworkingStack;
  redis: RedisStack;
  ecsPeers: CacheToEcsPeer[];
}

// @intent Edge: open Redis from Fargate + inject portable cache secrets (no Redis→ECS cycle)
export class CacheToEcsStack extends Stack {
  constructor(scope: Construct, id: string, props: CacheToEcsStackProps) {
    super(scope, id, props);

    const secret = props.redis.secret;
    if (!props.ecsPeers.length) return;

    props.ecsPeers.forEach((peer, index) => {
      new CfnSecurityGroupIngress(this, `EcsToRedis6379${index}`, {
        groupId: props.redis.cacheSecurityGroup.securityGroupId,
        sourceSecurityGroupId: Fn.importValue(peer.serviceSecurityGroupExportName),
        ipProtocol: 'tcp',
        fromPort: 6379,
        toPort: 6379,
        description: 'Redis from managed-host Fargate',
      });
    });

    for (const peer of props.ecsPeers) {
      const container = peer.taskDefinition.defaultContainer;
      if (!container) continue;
      const addEnv = (name: string, value: string) => {
        if (containerHasName(container, name)) return;
        container.addEnvironment(name, value);
        rememberContainerName(container, name);
      };
      addEnv('THONNAS_CACHE_TLS', 'true');
      addEnv('THONNAS_CACHE_SECRET_ARN', props.redis.secretArn);
      addEnv('THONNAS_CACHE_HOST', props.redis.endpoint);
      addEnv('THONNAS_CACHE_PORT', '6379');
      if (!containerHasName(container, 'THONNAS_CACHE_PASSWORD')) {
        container.addSecret('THONNAS_CACHE_PASSWORD', ecs.Secret.fromSecretsManager(secret));
        rememberContainerName(container, 'THONNAS_CACHE_PASSWORD');
      }
      secret.grantRead(peer.taskDefinition.obtainExecutionRole());
    }
  }
}



