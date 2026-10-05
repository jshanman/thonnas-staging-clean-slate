import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { NetworkingStack } from './networking-stack';

export interface NlbStackProps extends StackProps {
  profile: EnvProfile;
  networking: NetworkingStack;
  protocols: string[];
  // @intent Real backend IPs for the mqtt/ws/tcp target groups below -- omitted, the target
  // groups stay intentionally empty (no listening broker registered yet for this env).
  mqttTargetIps?: string[];
  // @intent ACM cert (same wildcard cert the ALB uses) for a TLS-terminating WSS listener on the
  // "ws" port + 1. Browsers refuse ws:// from an https:// page (mixed content); EMQX's own ws
  // listener stays plaintext, so the NLB terminates TLS and forwards decrypted traffic to it.
  certificateArn?: string;
}

// @intent WSS listener port = plain ws port + 1 (8083 -> 8084), matching EMQX's own convention
// of pairing a plaintext port with the next one up for the TLS variant (1883/8883, 8083/8084).
const WSS_PORT_OFFSET = 1;

export const EDGE_PROTOCOL_PORTS: Readonly<Record<string, number>> = {
  mqtt: 1883,
  ws: 8083,
  tcp: 1883,
};

// @intent Map extras protocols to unique TCP ports; skip unknown names
export function uniqueEdgePorts(protocols: string[]): number[] {
  const seen = new Set<number>();
  const ports: number[] = [];
  for (const proto of protocols) {
    const port = EDGE_PROTOCOL_PORTS[proto];
    if (!port || seen.has(port)) continue;
    seen.add(port);
    ports.push(port);
  }
  return ports;
}

// @intent Shared NLB for extras protocols on managed-host (empty TGs)
export class NlbStack extends Stack {
  public readonly nlb: elbv2.NetworkLoadBalancer;
  public readonly listenerPorts: number[];

  constructor(scope: Construct, id: string, props: NlbStackProps) {
    super(scope, id, props);
    this.nlb = new elbv2.NetworkLoadBalancer(this, 'EdgeNlb', {
      vpc: props.networking.vpc,
      internetFacing: true,
      vpcSubnets: props.networking.publicSubnetSelection,
      crossZoneEnabled: true,
      loadBalancerName: `${props.profile.envKey}-edge`.slice(0, 32),
    });
    this.listenerPorts = uniqueEdgePorts(props.protocols);
    const targetIps = (props.mqttTargetIps ?? []).filter((ip) => ip.trim().length > 0);
    const targetGroupsByPort = new Map<number, elbv2.NetworkTargetGroup>();
    for (const port of this.listenerPorts) {
      const tg = new elbv2.NetworkTargetGroup(this, `Tg${port}`, {
        vpc: props.networking.vpc,
        port,
        protocol: elbv2.Protocol.TCP,
        targetType: elbv2.TargetType.IP,
        // @intent Register every fleet node IP so the NLB actually load-balances/health-checks
        // across the real cluster instead of shipping an empty (always-refusing) target group.
        targets: targetIps.length > 0 ? targetIps.map((ip) => new elbv2targets.IpTarget(ip, port)) : undefined,
      });
      targetGroupsByPort.set(port, tg);
      this.nlb.addListener(`L${port}`, {
        port,
        protocol: elbv2.Protocol.TCP,
        defaultTargetGroups: [tg],
      });
    }

    // @intent Browsers refuse ws:// (insecure) WebSocket connections from a page loaded over
    // https:// (mixed content), so the browser-facing MQTT WebSocket path needs WSS. EMQX's own
    // ws listener (8083) stays plaintext -- rather than managing per-node TLS certs on the fleet,
    // the NLB terminates TLS here (reusing the same wildcard ACM cert the ALB already uses) and
    // forwards decrypted traffic to the existing plaintext ws target group. Confirmed via a real
    // browser test hitting the deployed staging site: connecting to ws:// from the https:// page
    // was blocked outright with a "must be available over WSS" console error.
    const wsPort = EDGE_PROTOCOL_PORTS.ws;
    const wsTargetGroup = targetGroupsByPort.get(wsPort);
    const certificateArn = props.certificateArn?.trim();
    if (wsTargetGroup && certificateArn) {
      const wssPort = wsPort + WSS_PORT_OFFSET;
      this.nlb.addListener('LWss', {
        port: wssPort,
        protocol: elbv2.Protocol.TLS,
        certificates: [elbv2.ListenerCertificate.fromArn(certificateArn)],
        defaultTargetGroups: [wsTargetGroup],
      });
      this.listenerPorts.push(wssPort);
    }

    new CfnOutput(this, 'NlbDnsName', {
      value: this.nlb.loadBalancerDnsName,
    });
    new CfnOutput(this, 'NlbListenerPorts', {
      value: this.listenerPorts.join(','),
    });
  }
}



