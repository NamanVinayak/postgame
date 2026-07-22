import { describe, expect, test } from 'vitest';
import { gameAccuracy, moveAccuracy } from './accuracy';

describe('moveAccuracy', () => {
  test('keeping the same win% is ~100% accurate', () => {
    expect(moveAccuracy(50, 50)).toBeGreaterThan(99);
  });
  test('a large win% drop is low accuracy', () => {
    expect(moveAccuracy(90, 30)).toBeLessThan(20);
  });
  test('is clamped to [0, 100]', () => {
    expect(moveAccuracy(100, 0)).toBeGreaterThanOrEqual(0);
    expect(moveAccuracy(50, 55)).toBeLessThanOrEqual(100);
  });
});

describe('gameAccuracy', () => {
  test('no moves defaults to 100', () => {
    expect(gameAccuracy([])).toBe(100);
  });
  test('is the mean of move accuracies', () => {
    expect(gameAccuracy([100, 100])).toBeCloseTo(100, 5);
    expect(gameAccuracy([100, 0])).toBeCloseTo(50, 5);
  });
});
