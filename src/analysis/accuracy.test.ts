import { describe, expect, test } from 'vitest';
import { gameAccuracies, moveAccuracy, type MoveScore } from './accuracy';
import type { Color } from '../types';

/** Build alternating-color moves (white, black, white, …) with given accuracies. */
function movesFrom(accuracies: number[]): MoveScore[] {
  return accuracies.map((accuracy, i) => ({
    color: (i % 2 === 0 ? 'white' : 'black') as Color,
    accuracy,
  }));
}

/** A flat, calm win% sequence of the right length (low volatility). */
function flatSeq(n: number): number[] {
  return Array.from({ length: n + 1 }, () => 50);
}

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

describe('gameAccuracies', () => {
  test('no moves defaults to 100 for both colors', () => {
    expect(gameAccuracies([50], [])).toEqual({ white: 100, black: 100 });
  });

  test('all-perfect play is 100', () => {
    const accs = [100, 100, 100, 100];
    const result = gameAccuracies(flatSeq(accs.length), movesFrom(accs));
    expect(result.white).toBeCloseTo(100, 5);
    expect(result.black).toBeCloseTo(100, 5);
  });

  test('a blunder drags that color below the arithmetic mean of its moves', () => {
    // White plays 3 great + 1 terrible move; black plays 4 great moves.
    const accs = [100, 100, 100, 100, 100, 100, 10, 100];
    const result = gameAccuracies(flatSeq(accs.length), movesFrom(accs));
    const whiteArithmetic = (100 + 100 + 10 + 100) / 4; // 77.5
    expect(result.white).toBeLessThan(whiteArithmetic);
    expect(result.black).toBeCloseTo(100, 5);
    expect(result.white).toBeLessThan(result.black);
  });

  test('scores stay within [0, 100]', () => {
    const accs = [0, 0, 100, 100];
    const result = gameAccuracies(flatSeq(accs.length), movesFrom(accs));
    expect(result.white).toBeGreaterThanOrEqual(0);
    expect(result.white).toBeLessThanOrEqual(100);
  });
});
