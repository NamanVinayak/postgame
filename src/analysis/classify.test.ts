import { describe, expect, test } from 'vitest';
import { classifyMove, isMissedWin } from './classify';

describe('classifyMove', () => {
  test('the engine move is best', () => {
    expect(classifyMove(30, true)).toBe('best');
  });
  test('a tiny loss counts as best', () => {
    expect(classifyMove(1, false)).toBe('best');
  });
  test('bands map correctly', () => {
    expect(classifyMove(3, false)).toBe('good');
    expect(classifyMove(7, false)).toBe('inaccuracy');
    expect(classifyMove(15, false)).toBe('mistake');
    expect(classifyMove(25, false)).toBe('blunder');
  });
});

describe('isMissedWin', () => {
  test('winning then dropping to equal is a missed win', () => {
    expect(isMissedWin(80, 50)).toBe(true);
  });
  test('never winning is not a missed win', () => {
    expect(isMissedWin(60, 50)).toBe(false);
  });
  test('winning but keeping most of it is not a missed win', () => {
    expect(isMissedWin(80, 60)).toBe(false);
  });
});
