import { describe, expect, it } from '@jest/globals';
import {
  CAPACITY_TABLE,
  extraKeyHasVendorToken,
  extraReleaseEnv,
  PORTABLE_EXTRA_KEYS,
  protectedReplacementReason,
  RELIABILITY_TABLE,
  hasOriginalScalingMin,
  resolvePortableExtras,
  shouldMergeResolvedHostEnv,
  stableWaitSeconds,
} from './portable-extras';

describe('PORTABLE_EXTRA_KEYS', () => {
  it('has no AWS product tokens as a key segment', () => {
    for (const key of PORTABLE_EXTRA_KEYS) {
      expect(extraKeyHasVendorToken(key)).toBe(false);
    }
  });

  it('flags vendor product tokens when they appear as a segment', () => {
    expect(extraKeyHasVendorToken('rds.instanceClass')).toBe(true);
    expect(extraKeyHasVendorToken('deploy.fargate')).toBe(true);
    expect(extraKeyHasVendorToken('capacity.cpu')).toBe(false);
  });
});

describe('release.env', () => {
  it('defaults to resolve so managed-host overlays .env.{env}', () => {
    expect(extraReleaseEnv(undefined)).toBe('resolve');
    expect(shouldMergeResolvedHostEnv({})).toBe(true);
  });

  it('skips compose host overlay when the package signals apply-time hosts', () => {
    expect(extraReleaseEnv({ 'release.env': 'apply' })).toBe('apply');
    expect(shouldMergeResolvedHostEnv({ 'release.env': 'apply' })).toBe(false);
  });

  it('rejects unknown release.env values', () => {
    expect(() => extraReleaseEnv({ 'release.env': 'compose' })).toThrow(/release\.env/);
  });
});

describe('resolvePortableExtras', () => {
  it('defaults development to xs+dev (CI / non-production)', () => {
    const extras = resolvePortableExtras({ env: 'development', extras: {} });
    expect(extras['capacity.cpu']).toBe(CAPACITY_TABLE.xs.cpu);
    expect(extras['capacity.memory']).toBe(CAPACITY_TABLE.xs.memory);
    expect(extras['scaling.min']).toBe(RELIABILITY_TABLE.dev.scalingMin);
    expect(extras['protect.fromDelete']).toBe(false);
    expect(extras['ha.multiAz']).toBe(false);
    expect(extras['backup.retentionDays']).toBe(1);
    expect(extras['logs.retentionDays']).toBe(7);
  });

  it('defaults staging and production to s+standard', () => {
    for (const env of ['staging', 'production', 'prod']) {
      const extras = resolvePortableExtras({ env, extras: {} });
      expect(extras['capacity.cpu']).toBe(CAPACITY_TABLE.s.cpu);
      expect(extras['capacity.memory']).toBe(CAPACITY_TABLE.s.memory);
      expect(extras['scaling.min']).toBe(2);
      expect(extras['protect.fromDelete']).toBe(true);
      expect(extras['ha.multiAz']).toBe(true);
      expect(extras['backup.retentionDays']).toBe(7);
      expect(extras.capacity).toBe('s');
      expect(extras.reliability).toBe('standard');
    }
  });

  it('lets package extras override the profile', () => {
    const extras = resolvePortableExtras({
      env: 'staging',
      extras: { capacity: 'xs', 'capacity.cpu': 256, 'scaling.min': 4, 'protect.fromDelete': false },
    });
    expect(extras['capacity.cpu']).toBe(256);
    expect(extras['scaling.min']).toBe(4);
    expect(extras['protect.fromDelete']).toBe(false);
    expect(extras['capacity.memory']).toBe(CAPACITY_TABLE.xs.memory);
  });

  it('rejects unknown capacity and reliability names', () => {
    expect(() => resolvePortableExtras({ env: 'staging', extras: { capacity: 'low-scale' } })).toThrow(/capacity/);
    expect(() => resolvePortableExtras({ env: 'staging', extras: { reliability: 'massive-scale' } })).toThrow(
      /reliability/,
    );
  });

  it('does not treat profile-expanded scaling.min as package-original', () => {
    expect(hasOriginalScalingMin({})).toBe(false);
    expect(hasOriginalScalingMin(resolvePortableExtras({ env: 'staging', extras: {} }))).toBe(false);
    expect(hasOriginalScalingMin({ 'scaling.min': 3 })).toBe(true);
    const expanded = resolvePortableExtras({ env: 'staging', extras: { 'scaling.min': 3 } });
    expect(hasOriginalScalingMin(expanded)).toBe(true);
    expect(expanded['scaling.min']).toBe(3);
  });

  it('does not invent Lambda memory keys', () => {
    const extras = resolvePortableExtras({ env: 'staging', extras: {} });
    expect(extras.memorySize).toBeUndefined();
    expect(extras['lambda.memory']).toBeUndefined();
  });
});

describe('stableWaitSeconds', () => {
  it('keeps the 480s floor when default grace is 60s', () => {
    expect(stableWaitSeconds({ env: 'staging', extras: {} })).toBe(480);
  });

  it('outlives package health.graceSeconds plus drain and ALB healthy threshold', () => {
    expect(stableWaitSeconds({ env: 'staging', extras: { 'health.graceSeconds': 600 } })).toBe(900);
  });

  it('lets deploy.waitSeconds override the derived wait', () => {
    expect(stableWaitSeconds({ env: 'staging', extras: { 'health.graceSeconds': 600, 'deploy.waitSeconds': 1200 } })).toBe(
      1200,
    );
  });
});

describe('protectedReplacementReason', () => {
  it('allows first create of a protected store', () => {
    expect(
      protectedReplacementReason({
        env: 'staging',
        extras: { reliability: 'standard', engine: 'postgres' },
        existing: false,
      }),
    ).toBeUndefined();
  });

  it('blocks engine change on an existing protected store', () => {
    const reason = protectedReplacementReason({
      env: 'staging',
      extras: { reliability: 'standard', engine: 'mysql', appliedEngine: 'postgres' },
      existing: true,
      appliedEngine: 'postgres',
    });
    expect(reason).toMatch(/engine postgres → mysql/);
  });

  it('does not block in-place backup or multi-AZ on create', () => {
    expect(
      protectedReplacementReason({
        env: 'staging',
        extras: { reliability: 'standard', 'ha.multiAz': true, 'backup.retentionDays': 7 },
        existing: false,
      }),
    ).toBeUndefined();
  });

  it('does not block unprotected dev', () => {
    expect(
      protectedReplacementReason({
        env: 'development',
        extras: { reliability: 'dev', engine: 'mysql', existing: true, appliedEngine: 'postgres' },
        existing: true,
        appliedEngine: 'postgres',
      }),
    ).toBeUndefined();
  });
});



