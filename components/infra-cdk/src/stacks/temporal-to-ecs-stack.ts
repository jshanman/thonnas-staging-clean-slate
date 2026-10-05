import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { EnvProfile } from '../cdk/env-profiles';
import { TemporalStack } from './temporal-stack';
import { containerHasName, rememberContainerName } from './container-names';

export interface TemporalToEcsPeer {
  taskDefinition: ecs.FargateTaskDefinition;
}

export interface TemporalToEcsStackProps extends StackProps {
  profile: EnvProfile;
  temporal: TemporalStack;
  ecsPeers: TemporalToEcsPeer[];
}

// @intent Edge: inject the real Cloud Map DNS name for Temporal's frontend service directly into
// every Fargate peer's task definition, the same portable-contract pattern CacheToEcsStack and
// MqttFleetToEcsStack already use for Redis/MQTT. Without this, any module depending on Temporal
// (e.g. tm-worker-temporal) had no reliable way to learn the real endpoint: it's only known at
// synth time (project-key + env baked into the Cloud Map namespace name by EcsSharedStack), so a
// module's own thonnas-config.json can only ever hardcode a guess -- confirmed live, where
// worker-manager-temporal's static "worker-manager-temporal.thonnas.staging.internal" guess (built
// assuming the project is literally named "thonnas") silently pointed nowhere for any differently
// named project, so Temporal's CreateSchedule calls failed with "no children to pick from" and the
// user-count cron never ran.
export class TemporalToEcsStack extends Stack {
  constructor(scope: Construct, id: string, props: TemporalToEcsStackProps) {
    super(scope, id, props);

    const endpoint = props.temporal.internalEndpoint;
    if (!endpoint || !props.ecsPeers.length) return;

    for (const peer of props.ecsPeers) {
      const container = peer.taskDefinition.defaultContainer;
      if (!container) continue;
      const addEnv = (name: string, value: string) => {
        if (containerHasName(container, name)) return;
        container.addEnvironment(name, value);
        rememberContainerName(container, name);
      };
      addEnv('THONNAS_TEMPORAL_ENDPOINT', endpoint);
    }
  }
}

