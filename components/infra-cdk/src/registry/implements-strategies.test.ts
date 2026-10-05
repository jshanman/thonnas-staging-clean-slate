import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

describe('implements_strategies catalog honesty', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../thonnas-package.json'), 'utf8'),
  ) as { thonnas?: { implements_strategies?: string[] } };
  const keys = pkg.thonnas?.implements_strategies ?? [];

  it('lists applied keys and omits cluster, queue.mqtt, and extra *-deploy', () => {
    const need = [
      'infra.container.managed-host',
      'infra.website.static',
      'infra.db.relational',
      'infra.compute.fleet.dba',
      'infra.db.document',
      'infra.cache.keyvalue',
      'infra.worker.temporal',
      'infra.observe.metrics',
      'infra.observe.dashboard',
      'comms.events.pub-sub.sns',
    ];
    expect(need.filter((key) => !keys.includes(key))).toEqual([]);
    expect(keys.filter((key) => /-deploy$/.test(key) && key !== 'infra.artifact.deploy')).toEqual([]);
    expect(keys).not.toContain('infra.container.cluster');
    expect(keys).not.toContain('infra.queue.mqtt');
  });
});



