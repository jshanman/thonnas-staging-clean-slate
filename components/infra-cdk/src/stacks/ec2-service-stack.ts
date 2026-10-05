import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  MachineImage,
  SecurityGroup,
  Peer,
  Port,
} from 'aws-cdk-lib/aws-ec2';
import { Role, ServicePrincipal, ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { NetworkingStack } from './networking-stack';
import { EnvProfile } from '../cdk/env-profiles';
import { ResolvedCloudComponent } from '../types';

export interface Ec2ServiceStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  networking: NetworkingStack;
  repositoryName: string;
  imageTag: string;
  /** AWS region for ECR login and CLI on the instance */
  region?: string;
  /** AWS account ID (reserved for future ECR/ARN wiring; optional) */
  accountId?: string;
  /** When set, EC2 instance role gets s3:GetObject, PutObject, DeleteObject, ListBucket on these buckets (e.g. from infra.storage in same component) */
  bucketNames?: string[];
}

// @intent Provision single EC2 docker host per component for beta/beta-feat
export class Ec2ServiceStack extends Stack {
  constructor(scope: Construct, id: string, props: Ec2ServiceStackProps) {
    super(scope, id, props);

    // @intent Create ECR (same formula as plan/release); do not assume a hand-created repo
    const repository = new Repository(this, 'Repository', {
      repositoryName: props.repositoryName,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 5 }],
    });
    const imageUri = `${repository.repositoryUri}:${props.imageTag}`;

    const securityGroup = new SecurityGroup(this, 'SecurityGroup', {
      vpc: props.networking.vpc,
      securityGroupName: `${props.profile.envKey}-${props.component.component}-ec2-sg`,
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(props.component.metadata.ports?.[0] ?? 80), 'Allow HTTP');

    const role = new Role(this, 'InstanceRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly')],
    });

    role.addToPolicy(
      new PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    if (props.bucketNames && props.bucketNames.length > 0) {
      role.addToPolicy(
        new PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
          resources: [
            ...props.bucketNames.map((b) => `arn:aws:s3:::${b}`),
            ...props.bucketNames.map((b) => `arn:aws:s3:::${b}/*`),
          ],
        }),
      );
    }

    const instance = new Instance(this, 'Instance', {
      vpc: props.networking.vpc,
      vpcSubnets: props.networking.publicSubnetSelection,
      securityGroup,
      role,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
      machineImage: MachineImage.latestAmazonLinux2023(),
      instanceName: `${props.profile.envKey}-${props.component.component}-host`,
    });

    const region = props.region ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';

    instance.userData.addCommands(
      'yum install -y docker awscli',
      'systemctl enable docker',
      'systemctl start docker',
      `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${repository.repositoryUri}`,
      `docker run -d --restart=always -p ${props.component.metadata.ports?.[0] ?? 80}:${
        props.component.metadata.ports?.[0] ?? 80
      } ${imageUri}`,
    );
  }
}




