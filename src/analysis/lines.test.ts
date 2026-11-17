import { describe, expect, test } from 'vitest';
import { formatLineSan, lineChips, linePositions, uciLineToSan } from './lines';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('uciLineToSan', () => {
  test('converts a UCI line to SAN, including castling and captures', () => {
    expect(uciLineToSan(START, ['e2e4', 'e7e5', 'g1f3', 'b8c6'])).toEqual([
      'e4',
      'e5',
      'Nf3',
      'Nc6',
    ]);
  });

  test('handles promotions', () => {
    const fen = '8/P7/8/8/8/8/k6K/8 w - - 0 1';
    // The new queen checks the black king down the a-file.
    expect(uciLineToSan(fen, ['a7a8q'])).toEqual(['a8=Q+']);
  });

  test('returns null when a move is illegal', () => {
    expect(uciLineToSan(START, ['e2e4', 'e2e5'])).toBeNull();
    expect(uciLineToSan(START, ['e2e4', 'bogus'])).toBeNull();
    expect(uciLineToSan('not a fen', ['e2e4'])).toBeNull();
  });

  test('an empty line is an empty SAN list', () => {
    expect(uciLineToSan(START, [])).toEqual([]);
  });
});

describe('linePositions', () => {
  test('returns the start FEN plus one FEN per move', () => {
    const fens = linePositions(START, ['e2e4', 'e7e5']);
    expect(fens).toHaveLength(3);
    expect(fens?.[0]).toBe(START);
    expect(fens?.[1]).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(fens?.[2]).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  });

  test('returns null when a move is illegal', () => {
    expect(linePositions(START, ['e2e4', 'e2e5'])).toBeNull();
  });
});

describe('lineChips / formatLineSan', () => {
  test('numbers a line starting on White to move', () => {
    expect(formatLineSan(['e4', 'e5', 'Nf3'], 0)).toBe('1. e4 e5 2. Nf3');
    expect(lineChips(['e4', 'e5', 'Nf3'], 0)).toEqual([
      { label: '1. e4', step: 1 },
      { label: 'e5', step: 2 },
      { label: '2. Nf3', step: 3 },
    ]);
  });

  test('numbers a line starting on Black to move with ellipsis', () => {
    // Ply 11 is Black's 6th move.
    expect(formatLineSan(['Nf6', 'Qxd4', 'Nxd4'], 11)).toBe('6... Nf6 7. Qxd4 Nxd4');
  });
});
