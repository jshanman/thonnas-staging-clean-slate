import { describe, expect, it } from '@jest/globals';
import { resolveStrategies } from '../../registry/resolve-strategies';
import { workshopIntents } from './workshop-intents';

describe('workshop intent matrix', () => {
  const intents = workshopIntents();
  const result = resolveStrategies(intents, {
    env: 'staging',
    rootDomain: 'example.local',
  });

  it('composes login+count plus worker and observe with anonymous fixture keys', () => {
    const byComponent = Object.fromEntries(result.components.map((c) => [c.component, c.construct]));
    expect(byComponent['fixture-web']).toBe('StaticSite');
    expect(byComponent['fixture-api']).toBe('ECSFargateService');
    expect(byComponent['fixture-pg']).toBe('RdsPostgresInstance');
    expect(byComponent['fixture-doc']).toBe('AwsDocumentDbCluster');
    expect(byComponent['fixture-cache']).toBe('ElasticacheRedisCluster');
    expect(byComponent['fixture-temporal']).toBe('TemporalServer');
    expect(byComponent['fixture-temporal-ui']).toBe('ECSFargateService');
    expect(byComponent['fixture-observe']).toBe('ObserveIngest');
    expect(result.components.every((c) => c.component.startsWith('fixture-'))).toBe(true);
    const docConstructs = result.components.filter((c) => c.construct === 'AwsDocumentDbCluster');
    expect(docConstructs).toHaveLength(1);
  });

  it('keeps the same construct family for two managed-host fixtures', () => {
    const hosts = result.components.filter((c) => c.construct === 'ECSFargateService');
    expect(hosts.map((c) => c.component).sort()).toEqual(['fixture-api', 'fixture-temporal-ui']);
    expect(new Set(hosts.map((c) => c.construct)).size).toBe(1);
  });

  it('keeps mqtt/ws extras on the managed-host API fixture', () => {
    const api = result.components.find((c) => c.component === 'fixture-api');
    expect(api?.metadata.protocols).toEqual(['mqtt', 'ws']);
  });

  it('keeps workshop dotted domainPattern and does not use live hyphen tokens', () => {
    expect(intents.every((intent) => intent.domainPattern === '{env}.{component}.example.local')).toBe(true);
    expect(intents.some((intent) => intent.domainPattern.includes('{env}-{component}'))).toBe(false);
  });
});



