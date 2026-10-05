import { Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { MqttFleetStack } from './mqtt-fleet-stack';
import { containerHasName, rememberContainerName } from './container-names';

export interface MqttFleetToEcsPeer {
  taskDefinition: ecs.FargateTaskDefinition;
  serviceSecurityGroupExportName: string;
}

export interface MqttFleetToEcsStackProps extends StackProps {
  profile: EnvProfile;
  networking: NetworkingStack;
  mqttFleet: MqttFleetStack;
  servicePorts: number[];
  ecsPeers: MqttFleetToEcsPeer[];
}

// @intent Edge: open the MQTT fleet from Fargate + inject the broker-admin credential as a real
// ECS-native secret (ecs.Secret.fromSecretsManager -- decrypted value lands in the container's
// env at launch, no AWS SDK call needed in app code). Mirrors cache-to-ecs-stack.ts exactly; the
// same "no cycle back to the fleet stack" shape applies (fleet -> ECS only, never the reverse).
export class MqttFleetToEcsStack extends Stack {
  constructor(scope: Construct, id: string, props: MqttFleetToEcsStackProps) {
    super(scope, id, props);

    const secret = props.mqttFleet.secret;
    if (!props.ecsPeers.length) return;

    props.ecsPeers.forEach((peer, peerIndex) => {
      props.servicePorts.forEach((port) => {
        new CfnSecurityGroupIngress(this, `EcsToMqtt${port}Peer${peerIndex}`, {
          groupId: props.mqttFleet.ingestSecurityGroup.securityGroupId,
          sourceSecurityGroupId: Fn.importValue(peer.serviceSecurityGroupExportName),
          ipProtocol: 'tcp',
          fromPort: port,
          toPort: port,
          description: `MQTT fleet port ${port} from managed-host Fargate`,
        });
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
      // @intent Env var names must match what consuming app code actually reads (e.g. api-go's
      // generated applyEnvOverrides() reads QUEUE_MQTT_INTERNAL_HOST/PORT, the same names the
      // standard thonnas-infra.json derivation convention produces everywhere else) -- confirmed
      // via a live crash: api-go connected to "localhost:1883" because THONNAS_MQTT_HOST/PORT were
      // injected here but nothing in the app ever reads those names, so the fleet endpoint never
      // reached the container and MQTT module init panicked on a nil client.
      addEnv('QUEUE_MQTT_INTERNAL_HOST', props.mqttFleet.endpointHost);
      addEnv('QUEUE_MQTT_INTERNAL_PORT', String(props.servicePorts[0] ?? 1883));
      addEnv('THONNAS_MQTT_SECRET_ARN', props.mqttFleet.secretArn);
      if (!containerHasName(container, 'THONNAS_MQTT_USERNAME')) {
        container.addSecret('THONNAS_MQTT_USERNAME', ecs.Secret.fromSecretsManager(secret, 'username'));
        rememberContainerName(container, 'THONNAS_MQTT_USERNAME');
      }
      if (!containerHasName(container, 'THONNAS_MQTT_PASSWORD')) {
        container.addSecret('THONNAS_MQTT_PASSWORD', ecs.Secret.fromSecretsManager(secret, 'password'));
        rememberContainerName(container, 'THONNAS_MQTT_PASSWORD');
      }
      secret.grantRead(peer.taskDefinition.obtainExecutionRole());
    }
  }
}

