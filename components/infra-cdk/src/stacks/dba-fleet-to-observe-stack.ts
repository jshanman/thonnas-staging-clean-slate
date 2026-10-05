import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import { Secret } from 'aws-cdk-lib/aws-ecs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { DbaFleetStack } from './dba-fleet-stack';
import { ObserveStack } from './observe-stack';

const DEFAULT_SERVICE_PORTS = [8123, 9000];

export interface DbaFleetToObserveStackProps extends StackProps {
  profile: EnvProfile;
  networking: NetworkingStack;
  fleet: DbaFleetStack;
  observe: ObserveStack;
  /** Override ingest ports opened from observe peer SGs (default 8123/9000). */
  servicePorts?: number[];
}

// @intent Edge stack: open DBA fleet ingest from observe + inject portable fleet env
export class DbaFleetToObserveStack extends Stack {
  constructor(scope: Construct, id: string, props: DbaFleetToObserveStackProps) {
    super(scope, id, props);

    const ports =
      props.servicePorts?.filter((port) => Number.isFinite(port) && port > 0) ?? DEFAULT_SERVICE_PORTS;

    const fleetSgId = props.fleet.ingestSecurityGroup.securityGroupId;
    const peers: Array<{ id: string; sgId: string; label: string }> = [];
    if (props.observe.collectorSecurityGroup) {
      peers.push({
        id: 'Collector',
        sgId: props.observe.collectorSecurityGroup.securityGroupId,
        label: 'collector',
      });
    }
    if (props.observe.dashboardSecurityGroup) {
      peers.push({
        id: 'Dashboard',
        sgId: props.observe.dashboardSecurityGroup.securityGroupId,
        label: 'dashboard',
      });
    }

    // @intent Peer SG ingress only — no product env keys on this edge
    if (ports.length > 0) {
      peers.forEach((peer) => {
        ports.forEach((port) => {
          new CfnSecurityGroupIngress(this, `${peer.id}ToFleet${port}`, {
            groupId: fleetSgId,
            sourceSecurityGroupId: peer.sgId,
            ipProtocol: 'tcp',
            fromPort: port,
            toPort: port,
            description: `DBA fleet port ${port} from observe ${peer.label}`,
          });
        });
      });
    }

    // @intent Inject portable THONNAS_DBA_FLEET_* into observe tasks (no vendor keys)
    const fleetEnv: Array<[string, string]> = [
      ['THONNAS_DBA_FLEET_HOST', props.fleet.endpointHost],
      ['THONNAS_DBA_FLEET_SECRET_ARN', props.fleet.secretArn],
      ['THONNAS_DBA_FLEET_VOLUME_PATH', props.fleet.volumePath],
    ];
    const passwordSecret = Secret.fromSecretsManager(props.fleet.secret, 'password');
    const tasks = [
      props.observe.collectorTaskDefinition,
      props.observe.dashboardTaskDefinition,
    ].filter((task): task is NonNullable<typeof task> => Boolean(task));
    for (const task of tasks) {
      const container = task.defaultContainer;
      if (!container) continue;
      for (const [name, value] of fleetEnv) {
        container.addEnvironment(name, value);
      }
      // @intent Password via SM secret ref — never plaintext in the template
      container.addSecret('THONNAS_DBA_FLEET_PASSWORD', passwordSecret);
      props.fleet.secret.grantRead(task.obtainExecutionRole());
    }
  }
}



