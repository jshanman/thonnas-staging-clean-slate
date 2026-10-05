import { Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';

export interface NetworkingStackProps extends StackProps {
  profile: EnvProfile;
  cidr?: string;
  /** Override AZ count; when set, stack uses this instead of deriving from profile. Use 2 when other stacks (e.g. EcsShared) may import subnet exports so updates never remove them. */
  maxAzs?: number;
}

export interface NetworkingOutputs {
  vpc: ec2.IVpc;
  publicSubnetSelection: ec2.SubnetSelection;
  privateSubnetSelection?: ec2.SubnetSelection;
}

// @intent Provision VPC/subnets; use at least 2 AZs when ALB is required (ALB needs 2 subnets in 2 AZs)
export class NetworkingStack extends Stack implements NetworkingOutputs {
  public readonly vpc: ec2.IVpc;

  public readonly publicSubnetSelection: ec2.SubnetSelection;

  public readonly privateSubnetSelection?: ec2.SubnetSelection;

  constructor(scope: Construct, id: string, props: NetworkingStackProps) {
    super(scope, id, props);

    const subnetConfiguration: ec2.SubnetConfiguration[] = [
      {
        subnetType: ec2.SubnetType.PUBLIC,
        name: `${props.profile.envKey}-public`,
        cidrMask: 24,
      },
      ...(props.profile.enablePrivateSubnets
        ? [
            {
              subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
              name: `${props.profile.envKey}-private`,
              cidrMask: 24,
            },
          ]
        : []),
    ];

    // @intent Use caller-provided maxAzs when set; otherwise 2 when ALB required (ALB needs 2 subnets in 2 AZs)
    const needAlb = props.profile.requireAlb || props.profile.allowFargate;
    const maxAzs = props.maxAzs ?? (needAlb ? 2 : 1);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${props.profile.envKey}-vpc`,
      maxAzs,
      ipAddresses: ec2.IpAddresses.cidr(props.cidr ?? '10.42.0.0/16'),
      natGateways: props.profile.createNatGateway ? 1 : 0,
      subnetConfiguration,
    });

    this.publicSubnetSelection = { subnets: this.vpc.publicSubnets };
    if (props.profile.enablePrivateSubnets) {
      this.privateSubnetSelection = { subnets: this.vpc.privateSubnets };
    }
  }
}




