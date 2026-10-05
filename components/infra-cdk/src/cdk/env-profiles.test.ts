import { describe, expect, it } from '@jest/globals';
import { resolveEnvCategory } from './env-profiles';

describe('resolveEnvCategory', () => {
  it('maps staging not release', () => {
    expect(resolveEnvCategory('staging')).toBe('staging');
    expect(resolveEnvCategory('production')).toBe('prod');
    expect(resolveEnvCategory('prod')).toBe('prod');
    expect(resolveEnvCategory('release')).toBe('custom');
  });
});



