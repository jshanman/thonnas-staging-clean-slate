import {
  DependencyGraph,
  GraphEdge,
  GraphNode,
  GraphNodeScope,
  PlannedResource,
  ResolvedCloudComponent,
  DeploymentIntent,
  StrategyResolutionResult,
} from '../types';
import { sanitizeSegment } from '../utils/path-helpers';

interface BuildContext {
  env: string;
  envCategory: 'beta' | 'beta-feat' | 'staging' | 'prod' | 'custom';
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  resources: Map<string, PlannedResource>;
  intents: DeploymentIntent[];
}

const addEdge = (ctx: BuildContext, from: string, to: string, reason: string): void => {
  ctx.edges.push({ from, to, reason });
};

const ensureNode = (
  ctx: BuildContext,
  id: string,
  type: string,
  scope: GraphNodeScope,
  props: Record<string, unknown> = {},
): GraphNode => {
  if (!ctx.nodes.has(id)) {
    ctx.nodes.set(id, { id, type, scope, props });
  } else {
    const existing = ctx.nodes.get(id)!;
    existing.props = { ...existing.props, ...props };
  }
  return ctx.nodes.get(id)!;
};

const envCategoryOf = (env: string): BuildContext['envCategory'] => {
  if (env === 'beta') return 'beta';
  if (env.startsWith('beta-feat')) return 'beta-feat';
  if (env === 'staging') return 'staging';
  if (env === 'prod' || env === 'production') return 'prod';
  return 'custom';
};

const envHasPrivateSubnet = (category: BuildContext['envCategory']): boolean => {
  return category === 'staging' || category === 'prod' || category === 'custom';
};

const ensureNetworking = (ctx: BuildContext): void => {
  const env = ctx.env;
  const hasPrivate = envHasPrivateSubnet(ctx.envCategory);

  ensureNode(ctx, `${env}-vpc`, 'VPC', 'shared', { cidrBlock: '10.0.0.0/16' });

  const publicSubnet = ensureNode(ctx, `${env}-public-subnet`, 'Subnet', 'shared', {
    cidrBlock: '10.0.1.0/24',
    visibility: 'public',
  });
  addEdge(ctx, publicSubnet.id, `${env}-vpc`, 'within');

  if (hasPrivate) {
    const privateSubnet = ensureNode(ctx, `${env}-private-subnet`, 'Subnet', 'shared', {
      cidrBlock: '10.0.2.0/24',
      visibility: 'private',
    });
    addEdge(ctx, privateSubnet.id, `${env}-vpc`, 'within');
  } else {
    // Create placeholder node so dependencies can reference it even if unavailable
    const privateSubnet = ensureNode(ctx, `${env}-private-subnet`, 'Subnet', 'shared', {
      cidrBlock: '10.0.2.0/24',
      visibility: 'private',
      available: false,
      note: 'Private subnets unavailable in beta environments',
    });
    addEdge(ctx, privateSubnet.id, `${env}-vpc`, 'within');
  }

  const igw = ensureNode(ctx, `${env}-internet-gateway`, 'InternetGateway', 'shared', {});
  addEdge(ctx, igw.id, `${env}-vpc`, 'attached_to');
};

const getResourceProps = (
  ctx: BuildContext,
  kind: string,
  component?: ResolvedCloudComponent,
): Record<string, unknown> => {
  // Attempt to locate planned resource for richer metadata
  const resource = ctx.resources.get(kind);
  if (resource) {
    return resource.props;
  }

  // Build fallback props
  if (component && kind === 'logGroup') {
    return { name: `/thonnas/${ctx.env}/${component.component}` };
  }

  return {};
};

const ensureSecurityGroupEdge = (ctx: BuildContext, sgId: string, targetId: string, reason: string): void => {
  if (ctx.nodes.has(sgId) && ctx.nodes.has(targetId)) {
    addEdge(ctx, sgId, targetId, reason);
  }
};

const ensureRequirement = (
  ctx: BuildContext,
  requirement: string,
  component: ResolvedCloudComponent,
): void => {
  const env = ctx.env;
  const componentNode = componentNodeId(component);
  switch (requirement) {
    case 'vpc':
      ensureNode(ctx, `${env}-vpc`, 'VPC', 'shared');
      addEdge(ctx, componentNode, `${env}-vpc`, 'runs_in');
      break;
    case 'publicSubnet':
      ensureNode(ctx, `${env}-public-subnet`, 'Subnet', 'shared', { visibility: 'public' });
      addEdge(ctx, componentNode, `${env}-public-subnet`, 'runs_in');
      break;
    case 'privateSubnet':
      ensureNode(ctx, `${env}-private-subnet`, 'Subnet', 'shared', {
        visibility: 'private',
        available: envHasPrivateSubnet(ctx.envCategory),
      });
      addEdge(ctx, componentNode, `${env}-private-subnet`, 'runs_in');
      break;
    case 'ecsCluster': {
      const cluster = ensureNode(ctx, `${env}-ecs-cluster`, 'ECSCluster', 'shared');
      addEdge(ctx, cluster.id, `${env}-private-subnet`, 'uses');
      addEdge(ctx, componentNode, cluster.id, 'scheduled_on');
      break;
    }
    case 'applicationLoadBalancer': {
      const alb = ensureNode(ctx, `${env}-alb`, 'ApplicationLoadBalancer', 'shared', {
        available: ctx.envCategory !== 'beta' || component.metadata.routing === 'alb',
      });
      addEdge(ctx, alb.id, `${env}-public-subnet`, 'attached_to');
      addEdge(ctx, componentNode, alb.id, 'fronted_by');
      break;
    }
    case 'albSecurityGroup': {
      const sg = ensureNode(ctx, `${env}-alb-sg`, 'SecurityGroup', 'shared', {
        description: 'Public-facing ALB',
      });
      ensureSecurityGroupEdge(ctx, sg.id, `${env}-public-subnet`, 'applies_to');
      break;
    }
    case 'listenerHttps': {
      const listener = ensureNode(ctx, `${env}-alb-listener-443`, 'Listener', 'shared', { port: 443 });
      addEdge(ctx, listener.id, `${env}-alb`, 'attached_to');
      break;
    }
    case 'routingRule': {
      const rule = ensureNode(ctx, `${component.id}-routing-rule`, 'ListenerRule', 'service', {
        hostname: component.metadata.hostname,
      });
      addEdge(ctx, rule.id, `${env}-alb-listener-443`, 'attached_to');
      break;
    }
    case 'targetGroup': {
      const tg = ensureNode(ctx, `${component.id}-tg`, 'TargetGroup', 'service', {
        port: component.metadata.targetGroupPort,
        protocol: 'HTTP',
      });
      addEdge(ctx, tg.id, `${component.id}-routing-rule`, 'forwards_to');
      addEdge(ctx, componentNode, tg.id, 'receives_traffic_from');
      break;
    }
    case 'ecrRepository': {
      const repoId = `ecr-${ctx.env}-${component.component}`;
      const repo = ensureNode(ctx, repoId, 'ECRRepository', 'service', getResourceProps(ctx, repoId));
      addEdge(ctx, componentNode, repo.id, 'pulls_image_from');
      break;
    }
    case 'ecsExecutionRole': {
      const roleId = `iam-${ctx.env}-${component.component}-ecs-exec`;
      const role = ensureNode(ctx, roleId, 'IAMRole', 'service', getResourceProps(ctx, roleId));
      addEdge(ctx, componentNode, role.id, 'assumes_role');
      break;
    }
    case 'ecsTaskRole': {
      const roleId = `iam-${ctx.env}-${component.component}-ecs-task`;
      const role = ensureNode(ctx, roleId, 'IAMRole', 'service', getResourceProps(ctx, roleId));
      addEdge(ctx, componentNode, role.id, 'assumes_role');
      break;
    }
    case 'ecsTaskSecurityGroup': {
      const sgId = `sg-${ctx.env}-${component.component}-ecs-sg`;
      const sg = ensureNode(ctx, sgId, 'SecurityGroup', 'service', { description: 'ECS task security group' });
      ensureSecurityGroupEdge(ctx, sg.id, `${env}-alb-sg`, 'ingress_from');
      addEdge(ctx, componentNode, sg.id, 'protected_by');
      break;
    }
    case 'ec2SecurityGroup': {
      const sgId = `sg-${ctx.env}-${component.component}-ec2`;
      const sg = ensureNode(ctx, sgId, 'SecurityGroup', 'service', { description: 'EC2 host security group' });
      ensureSecurityGroupEdge(ctx, sg.id, `${env}-public-subnet`, 'applies_to');
      addEdge(ctx, componentNode, sg.id, 'protected_by');
      break;
    }
    case 'ec2InstanceRole': {
      const roleId = `iam-${ctx.env}-${component.component}-ec2`;
      const role = ensureNode(ctx, roleId, 'IAMRole', 'service', getResourceProps(ctx, roleId));
      addEdge(ctx, componentNode, role.id, 'assumes_role');
      break;
    }
    case 'ec2Instance': {
      const instanceId = `${component.id}-ec2`;
      const instance = ensureNode(ctx, instanceId, 'EC2Instance', 'service', { type: 't3.medium' });
      addEdge(ctx, componentNode, instance.id, 'runs_on');
      break;
    }
    case 'logGroup': {
      const logId = `log-${ctx.env}-${component.component}`;
      const logGroup = ensureNode(ctx, logId, 'LogGroup', 'service', getResourceProps(ctx, logId));
      addEdge(ctx, componentNode, logGroup.id, 'logs_to');
      break;
    }
    case 'composeLogGroup': {
      const logId = `log-${ctx.env}-${component.component}`;
      const logGroup = ensureNode(ctx, logId, 'LogGroup', 'service', getResourceProps(ctx, logId));
      addEdge(ctx, componentNode, logGroup.id, 'logs_to');
      break;
    }
    case 'dbSecurityGroup': {
      const sgId = `sg-${ctx.env}-${component.component}-db`;
      const sg = ensureNode(ctx, sgId, 'SecurityGroup', 'service', { description: 'Database security group' });
      ensureSecurityGroupEdge(ctx, sg.id, componentNode, 'ingress_from');
      break;
    }
    case 'dbSubnetGroup': {
      const subnetGroupId = `${component.id}-db-subnet-group`;
      const subnet = ensureNode(ctx, subnetGroupId, 'SubnetGroup', 'service', {});
      addEdge(ctx, subnet.id, `${ctx.env}-private-subnet`, 'includes');
      addEdge(ctx, componentNode, subnet.id, 'runs_in');
      break;
    }
    case 'dbSecret': {
      const secretId = `${component.id}-db-secret`;
      const secret = ensureNode(ctx, secretId, 'Secret', 'service', {});
      addEdge(ctx, componentNode, secret.id, 'reads_from');
      break;
    }
    case 'composeSecurityGroup': {
      const sgId = `sg-${ctx.env}-${component.component}-compose-host`;
      const sg = ensureNode(ctx, sgId, 'SecurityGroup', 'service', { description: 'Compose host security group' });
      ensureSecurityGroupEdge(ctx, sg.id, `${env}-public-subnet`, 'applies_to');
      addEdge(ctx, componentNode, sg.id, 'protected_by');
      break;
    }
    case 'composeInstanceRole': {
      const roleId = `iam-${ctx.env}-${component.component}-compose`;
      const role = ensureNode(ctx, roleId, 'IAMRole', 'service', getResourceProps(ctx, roleId));
      addEdge(ctx, componentNode, role.id, 'assumes_role');
      break;
    }
    case 'composeHostInstance': {
      const compose = component.metadata.compose;
      const instanceId = `${component.id}-compose-host`;
      const instance = ensureNode(ctx, instanceId, 'ComposeHostInstance', 'service', {
        gitRepositoryUrl: compose?.gitRepositoryUrl,
        branch: compose?.branch,
        publishedServices: compose?.publishedServices,
        gitPasswordSecretName: compose?.gitPasswordSecretName,
      });
      addEdge(ctx, componentNode, instance.id, 'runs_on');
      addEdge(ctx, instance.id, `${env}-public-subnet`, 'runs_in');
      break;
    }
    case 'elasticIp': {
      const eipId = `eip-${ctx.env}-${component.component}`;
      const eip = ensureNode(ctx, eipId, 'ElasticIp', 'service', {});
      addEdge(ctx, componentNode, eip.id, 'associated_with');
      break;
    }
    case 'route53Records': {
      const compose = component.metadata.compose;
      compose?.publishedServices.forEach((service) => {
        const recordId = `route53-${service.hostname}`;
        const record = ensureNode(ctx, recordId, 'Route53Record', 'service', {
          hostname: service.hostname,
          protocol: service.protocol,
          port: service.port,
        });
        addEdge(ctx, componentNode, record.id, 'exposes');
      });
      break;
    }
    case 's3WebsiteBucket': {
      const bucketId = `s3-website-${env}-${component.component}`;
      const bucket = ensureNode(ctx, bucketId, 'S3WebsiteBucket', 'service', getResourceProps(ctx, bucketId));
      addEdge(ctx, componentNode, bucket.id, 'uses');
      break;
    }
    case 's3StorageBucket': {
      const bucketId = `s3-storage-${env}-${component.component}`;
      const bucket = ensureNode(ctx, bucketId, 'S3StorageBucket', 'service', getResourceProps(ctx, bucketId));
      addEdge(ctx, componentNode, bucket.id, 'uses');
      break;
    }
    case 'route53AliasForS3': {
      const aliasId = `route53-alias-${env}-${component.component}`;
      const alias = ensureNode(ctx, aliasId, 'Route53AliasForS3', 'service', getResourceProps(ctx, aliasId));
      addEdge(ctx, componentNode, alias.id, 'exposes');
      break;
    }
    case 's3ArtifactDeployment': {
      const deployId = `s3-artifact-${env}-${component.component}`;
      const deploy = ensureNode(ctx, deployId, 'S3ArtifactDeployment', 'service', getResourceProps(ctx, deployId));
      addEdge(ctx, componentNode, deploy.id, 'deploys_to');
      break;
    }
    default:
      break;
  }
};

const componentNodeId = (component: ResolvedCloudComponent): string => {
  return `${component.id}-construct`;
};

const ensureComponentNode = (ctx: BuildContext, component: ResolvedCloudComponent): GraphNode => {
  const id = componentNodeId(component);
  return ensureNode(ctx, id, component.construct, component.scope, {
    hostname: component.metadata.hostname,
    runtimeType: component.metadata.runtimeType,
    routing: component.metadata.routing,
    ports: component.metadata.ports,
  });
};

const addServiceEdges = (ctx: BuildContext, component: ResolvedCloudComponent): void => {
  component.requires.forEach((req) => {
    ensureRequirement(ctx, req, component);
  });
};

export const buildDependencyGraph = (
  env: string,
  intents: DeploymentIntent[],
  resolution: StrategyResolutionResult,
): DependencyGraph => {
  const ctx: BuildContext = {
    env: sanitizeSegment(env) || env,
    envCategory: envCategoryOf(sanitizeSegment(env) || env),
    nodes: new Map(),
    edges: [],
    resources: new Map(resolution.resources.map((resource) => [resource.id, resource])),
    intents,
  };

  ensureNetworking(ctx);

  resolution.components.forEach((component) => {
    ensureComponentNode(ctx, component);
    addServiceEdges(ctx, component);
  });

  return {
    environment: ctx.env,
    nodes: Array.from(ctx.nodes.values()),
    edges: ctx.edges,
  };
};




