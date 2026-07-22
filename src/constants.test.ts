import { describe, expect, test } from 'vitest';
import { DELTA, SCHEMA_VERSION, MISSED_WIN } from './constants';

describe('constants', () => {
  test('classification thresholds are ordered', () => {
    expect(DELTA.good).toBeLessThan(DELTA.inaccuracy);
    expect(DELTA.inaccuracy).toBeLessThan(DELTA.mistake);
    expect(DELTA.mistake).toBeLessThan(DELTA.blunder);
  });

  test('schema version is a positive integer', () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  test('missed-win drop is below the winning threshold', () => {
    expect(MISSED_WIN.dropTo).toBeLessThan(MISSED_WIN.winningWinPct);
  });
});
