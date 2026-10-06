import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Cluster, ContainerInsights } from 'aws-cdk-lib/aws-ecs';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { SecurityGroup, Peer, Port } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { NetworkingStack } from './networking-stack';
import { EnvProfile } from '../cdk/env-profiles';

export interface EcsSharedStackProps extends StackProps {
  networking: NetworkingStack;
  profile: EnvProfile;
  rootDomain?: string;
  enableAlb: boolean;
  certificateArn?: string;
  /**
   * Container Insights emits many billable custom metrics.
   * Default false (opt-in) to stay under Free Tier / lab costs.
   */
  containerInsights?: boolean;
}

export interface EcsSharedOutputs {
  cluster?: Cluster;
  loadBalancer?: ApplicationLoadBalancer;
  httpsListener?: ApplicationListener;
  albSecurityGroup?: SecurityGroup;
}

/** ALB name max 32 chars; must be unique per account/region. Derive from stack name so multi-branch deploys do not collide. */
const albNameFromStack = (stackName: string): string => {
  const base = stackName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase().replace(/^-|-$/g, '');
  const prefix = base.slice(0, 28);
  return prefix ? `${prefix}-alb` : 'alb';
};

export const requiresAlbHttps = (profile: EnvProfile): boolean =>
  profile.allowFargate && (profile.category === 'staging' || profile.category === 'prod');

// @intent Provide shared ECS cluster + optional ACM HTTPS ALB for service stacks
export class EcsSharedStack extends Stack implements EcsSharedOutputs {
  public readonly cluster?: Cluster;

  public readonly loadBalancer?: ApplicationLoadBalancer;

  public readonly httpsListener?: ApplicationListener;

  public readonly albSecurityGroup?: SecurityGroup;

  /** Root domain for ALB hostname A-records (e.g. ts1.parfiamlabs.com). */
  public readonly rootDomain?: string;

  constructor(scope: Construct, id: string, props: EcsSharedStackProps) {
    super(scope, id, props);
    this.rootDomain = props.rootDomain?.trim() || undefined;

    if (props.profile.allowFargate) {
      // @intent Default Container Insights off; opt-in only (custom metrics cost)
      this.cluster = new Cluster(this, 'Cluster', {
        vpc: props.networking.vpc,
        clusterName: `${this.stackName}-cluster`,
        containerInsightsV2: props.containerInsights ? ContainerInsights.ENABLED : ContainerInsights.DISABLED,
      });
      // @intent Namespace includes project so multi-project envs do not share SC names
      const nsProject = (props.profile.projectKey || 'thonnas')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .slice(0, 24);
      this.cluster.addDefaultCloudMapNamespace({
        name: `${nsProject}.${props.profile.envKey}.internal`,
        vpc: props.networking.vpc,
      });
    }

    if (props.enableAlb) {
      this.albSecurityGroup = new SecurityGroup(this, 'AlbSecurityGroup', {
        vpc: props.networking.vpc,
        description: 'Shared ALB security group',
        allowAllOutbound: true,
        securityGroupName: `${this.stackName}-alb-sg`,
      });

      this.albSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'Allow HTTP');
      this.albSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'Allow HTTPS');

      this.loadBalancer = new ApplicationLoadBalancer(this, 'Alb', {
        vpc: props.networking.vpc,
        internetFacing: true,
        securityGroup: this.albSecurityGroup,
        loadBalancerName: albNameFromStack(this.stackName),
        vpcSubnets: props.networking.publicSubnetSelection,
        dropInvalidHeaderFields: true,
      });

      const certArn = props.certificateArn?.trim();
      if (requiresAlbHttps(props.profile) && !certArn && !this.rootDomain) {
        throw new Error(
          `Staging/production Fargate ALB requires ACM certificateArn ` +
            `(THONNAS_ALB_CERTIFICATE_ARN or extras.certificateArn), or --root-domain so a new wildcard ` +
            `cert can be requested and DNS-validated automatically. Missing both for env "${props.profile.envKey}".`,
        );
      }
      // @intent certArn (discovered or supplied) is used as-is. Otherwise, when this env
      // actually needs HTTPS and a root domain is known, request + DNS-validate a brand-new
      // wildcard cert covering every ALB-fronted ECS HTTP service's hyphenated domain
      // ({env}-{component}.{rootDomain}) -- CloudFormation's Certificate resource natively
      // waits for ACM to confirm ISSUED (DNS validation only, no human approval needed), so this
      // stack's own deploy may simply take a few minutes longer the first time. Matches the same
      // two-apply pattern static-site-stack.ts already uses for its own per-domain certs --
      // resolvePlanExistingState's ACM list-certs check surfaces PENDING/ISSUED on a later
      // `infra plan`, so a dependent ECS service stack stays correctly "blocked" until then
      // rather than silently skipping HTTPS.
      const certificate = certArn
        ? Certificate.fromCertificateArn(this, 'AlbCert', certArn)
        : requiresAlbHttps(props.profile) && this.rootDomain
          ? (() => {
              const zone = HostedZone.fromLookup(this, 'AlbCertZone', { domainName: this.rootDomain! });
              const cert = new Certificate(this, 'AlbCert', {
                domainName: `*.${this.rootDomain}`,
                validation: CertificateValidation.fromDns(zone),
              });
              cert.applyRemovalPolicy(RemovalPolicy.RETAIN);
              return cert;
            })()
          : undefined;

      if (certificate) {
        // @intent Keep HttpsListener on :80 so leftover HTTP ALBs update in place
        this.loadBalancer.addListener('HttpsListener', {
          port: 80,
          protocol: ApplicationProtocol.HTTP,
          open: true,
          defaultAction: ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
        });
        this.httpsListener = this.loadBalancer.addListener('Https443', {
          port: 443,
          protocol: ApplicationProtocol.HTTPS,
          certificates: [certificate],
          open: true,
          defaultAction: ListenerAction.fixedResponse(200, {
            contentType: 'text/plain',
            messageBody: 'Thonnas ALB HTTPS listener',
          }),
        });
      } else {
        this.httpsListener = this.loadBalancer.addListener('HttpsListener', {
          port: 80,
          protocol: ApplicationProtocol.HTTP,
          open: true,
          defaultAction: ListenerAction.fixedResponse(200, {
            contentType: 'text/plain',
            messageBody: 'Thonnas ALB listener placeholder',
          }),
        });
      }
    }
  }
}


