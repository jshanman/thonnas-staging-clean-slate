// @intent Provide AWS Route53 hosted zone auto-detection utilities
import { Route53Client, ListHostedZonesByNameCommand } from '@aws-sdk/client-route-53';

export interface DetectedHostedZone {
  id: string;
  name: string;
}

const client = new Route53Client({});
const lookupCache = new Map<string, DetectedHostedZone | null>();

const normalizeDomain = (domain: string): string => domain.replace(/\.$/, '').toLowerCase();

const generateDomainCandidates = (domain: string): string[] => {
  const parts = normalizeDomain(domain).split('.');
  if (parts.length < 2) {
    return [normalizeDomain(domain)];
  }

  const candidates: string[] = [];
  for (let i = 0; i <= parts.length - 2; i += 1) {
    candidates.push(parts.slice(i).join('.'));
  }
  return candidates;
};

export const detectHostedZoneForDomain = async (domain: string): Promise<DetectedHostedZone | undefined> => {
  const normalized = normalizeDomain(domain);
  if (lookupCache.has(normalized)) {
    return lookupCache.get(normalized) ?? undefined;
  }

  const candidates = generateDomainCandidates(domain);
  for (const candidate of candidates) {
    try {
      const response = await client.send(
        new ListHostedZonesByNameCommand({
          DNSName: candidate,
          MaxItems: 20,
        }),
      );

      const hostedZones = response.HostedZones ?? [];
      const match = hostedZones.find((zone) => {
        const zoneName = zone.Name ? normalizeDomain(zone.Name) : undefined;
        if (!zoneName || zone.Config?.PrivateZone) {
          return false;
        }
        return zoneName === normalizeDomain(candidate);
      });

      if (match?.Id) {
        const sanitizedId = match.Id.replace('/hostedzone/', '');
        const sanitizedName = match.Name ? normalizeDomain(match.Name) : candidate;
        const detected: DetectedHostedZone = { id: sanitizedId, name: sanitizedName };
        lookupCache.set(normalized, detected);
        return detected;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Credentials issues should not crash the planner; log for debugging and stop trying further domains
      if (message.includes('Credential') || message.includes('profile')) {
        console.warn('[infra-cdk] Hosted zone auto-detection skipped:', message);
        break;
      }
    }
  }

  lookupCache.set(normalized, null);
  return undefined;
};




