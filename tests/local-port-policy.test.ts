import { describe, expect, it } from 'vitest';

import { reserveConfiguredPort } from '../scripts/local-port-policy.mjs';

describe('local integration port policy', () => {
  it('preserves a valid configured port on repeat setup', () => {
    const used = new Set<number>();

    expect(reserveConfiguredPort(45187, used)).toBe(45187);
    expect(used).toEqual(new Set([45187]));
  });

  it('rejects invalid and duplicate configured ports', () => {
    const used = new Set([45187]);

    expect(reserveConfiguredPort(45187, used)).toBeUndefined();
    expect(reserveConfiguredPort(80, used)).toBeUndefined();
    expect(reserveConfiguredPort(undefined, used)).toBeUndefined();
  });
});
