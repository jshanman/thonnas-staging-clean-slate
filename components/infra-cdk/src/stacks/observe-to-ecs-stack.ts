import { Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnService } from 'aws-cdk-lib/aws-ecs';
import { CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';
import { EcsSharedStack } from './ecs-shared-stack';
import { ObserveStack, observeCollectorName } from './observe-stack';

export interface ObserveToEcsPeer {
  serviceSecurityGroupExportName: string;
}

export interface ObserveToEcsStackProps extends StackProps {
  profile: EnvProfile;
  networking: NetworkingStack;
  shared: EcsSharedStack;
  observe: ObserveStack;
  ecsPeers: ObserveToEcsPeer[];
  /** Prefer collectorName when known; otherwise derive from component + env. */
  collectorName?: string;
  collectorComponent?: string;
  collectorEnv?: string;
}

// @intent Edge stack: ECS→collector SG + Service Connect publish only
export class ObserveToEcsStack extends Stack {
  constructor(scope: Construct, id: string, props: ObserveToEcsStackProps) {
    super(scope, id, props);

    const collectorSg = props.observe.collectorSecurityGroup;
    if (!collectorSg) {
      return;
    }

    const collectorName =
      props.collectorName?.trim() ||
      observeCollectorName(
        props.collectorEnv?.trim() || props.profile.envKey,
        props.collectorComponent?.trim() || 'observe',
      );

    // @intent Grant each managed-host peer SG access to OTLP ports
    props.ecsPeers.forEach((peer, index) => {
      new CfnSecurityGroupIngress(this, `EcsPeerGrpc${index}`, {
        groupId: collectorSg.securityGroupId,
        sourceSecurityGroupId: Fn.importValue(peer.serviceSecurityGroupExportName),
        ipProtocol: 'tcp',
        fromPort: 4317,
        toPort: 4317,
        description: 'OTLP gRPC from ECS peer',
      });
      new CfnSecurityGroupIngress(this, `EcsPeerHttp${index}`, {
        groupId: collectorSg.securityGroupId,
        sourceSecurityGroupId: Fn.importValue(peer.serviceSecurityGroupExportName),
        ipProtocol: 'tcp',
        fromPort: 4318,
        toPort: 4318,
        description: 'OTLP HTTP from ECS peer',
      });
    });

    // @intent Publish portable collector discovery names into the shared Cloud Map namespace
    const collectorService = props.observe.collectorService;
    const namespace = props.shared.cluster?.defaultCloudMapNamespace;
    if (collectorService && namespace) {
      const cfn = collectorService.node.defaultChild as CfnService;
      cfn.serviceConnectConfiguration = {
        enabled: true,
        namespace: namespace.namespaceName,
        services: [
          {
            portName: 'otlp-http',
            discoveryName: collectorName,
            clientAliases: [{ port: 4318, dnsName: collectorName }],
          },
          {
            portName: 'otlp-grpc',
            discoveryName: `${collectorName}-grpc`,
            clientAliases: [{ port: 4317, dnsName: `${collectorName}-grpc` }],
          },
        ],
      };
    }
  }
}



