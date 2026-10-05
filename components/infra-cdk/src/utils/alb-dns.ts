import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';

// @intent Alias public hostname to shared Wiring ALB when zone + ALB are known
export function addAlbHostnameAlias(
  scope: Construct,
  id: string,
  opts: {
    hostname: string;
    hostedZoneDomain: string;
    loadBalancer: ApplicationLoadBalancer;
  },
): void {
  const hostname = opts.hostname.trim().replace(/\.$/, '');
  const zoneName = opts.hostedZoneDomain.trim().replace(/\.$/, '');
  if (!hostname || !zoneName) return;
  if (!hostname.endsWith(`.${zoneName}`) && hostname !== zoneName) {
    throw new Error(
      `Hostname "${hostname}" is not under hosted zone "${zoneName}" — cannot create ALB A-record.`,
    );
  }
  const zone = route53.HostedZone.fromLookup(scope, `${id}Zone`, { domainName: zoneName });
  const recordName =
    hostname === zoneName ? undefined : hostname.slice(0, -(zoneName.length + 1));
  new route53.ARecord(scope, id, {
    zone,
    recordName,
    target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(opts.loadBalancer)),
  });
}

// @intent Prefer package hosted_zone_domain, else shared rootDomain
export function resolveHostedZoneDomain(
  extras: Record<string, unknown> | undefined,
  rootDomain?: string,
): string | undefined {
  const fromExtras =
    typeof extras?.hosted_zone_domain === 'string' ? extras.hosted_zone_domain.trim() : '';
  // @intent Ignore unexpanded templates like {rootDomain}
  if (fromExtras && !fromExtras.includes('{')) return fromExtras;
  const root = rootDomain?.trim();
  return root || undefined;
}



