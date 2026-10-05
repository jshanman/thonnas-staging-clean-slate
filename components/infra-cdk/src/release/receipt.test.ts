import { describe, expect, it } from '@jest/globals';
import { isClosedReceiptStatus, mintReleaseId } from './receipt';

describe('receipt', () => {
  it('mints a UUID v4', () => {
    const id = mintReleaseId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('treats superseded and compensated as closed', () => {
    expect(isClosedReceiptStatus('superseded')).toBe(true);
    expect(isClosedReceiptStatus('compensated')).toBe(true);
    expect(isClosedReceiptStatus('deployed')).toBe(false);
  });
});



