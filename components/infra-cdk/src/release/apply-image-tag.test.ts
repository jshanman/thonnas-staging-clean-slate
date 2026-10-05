import { describe, expect, it } from '@jest/globals';
import { APPLY_IMAGE_TAG_WARNING, applyImageTagWarning } from './apply-image-tag';

describe('applyImageTagWarning', () => {
  it('warns when the tag is set and is not latest', () => {
    expect(applyImageTagWarning('sha-1')).toBe(APPLY_IMAGE_TAG_WARNING);
    expect(APPLY_IMAGE_TAG_WARNING).toMatch(/thonnas release --image-tag/);
    expect(APPLY_IMAGE_TAG_WARNING).toMatch(/stacks only/);
  });

  it('stays silent for latest or an omitted tag', () => {
    expect(applyImageTagWarning('latest')).toBeUndefined();
    expect(applyImageTagWarning(undefined)).toBeUndefined();
    expect(applyImageTagWarning('')).toBeUndefined();
  });
});



