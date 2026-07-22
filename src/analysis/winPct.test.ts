import { describe, expect, test } from 'vitest';
import { evalToWinPct } from './winPct';

describe('evalToWinPct', () => {
  test('an equal position is 50%', () => {
    expect(evalToWinPct(0, null)).toBeCloseTo(50, 5);
  });

  test('a large advantage approaches 100%', () => {
    expect(evalToWinPct(2000, null)).toBeGreaterThan(99);
  });

  test('a large disadvantage approaches 0%', () => {
    expect(evalToWinPct(-2000, null)).toBeLessThan(1);
  });

  test('forced mate is 100% (for) or 0% (against)', () => {
    expect(evalToWinPct(null, 1)).toBe(100);
    expect(evalToWinPct(null, -1)).toBe(0);
  });

  test('output is clamped to [0, 100]', () => {
    expect(evalToWinPct(100000, null)).toBeLessThanOrEqual(100);
    expect(evalToWinPct(-100000, null)).toBeGreaterThanOrEqual(0);
  });
});
