import { describe, expect, test } from 'vitest';
import { explainMistake, type ReasonCtx } from './reasons';

const base: ReasonCtx = {
  fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  fenAfter: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  playedSan: 'a3',
  bestMoveSan: 'e4',
  classification: 'blunder',
  isMissedWin: false,
  bestLeadsToMate: false,
  opponentReplySan: null,
};

describe('explainMistake', () => {
  test('non-notable moves get no reason', () => {
    expect(explainMistake({ ...base, classification: 'good' })).toBeNull();
    expect(explainMistake({ ...base, classification: 'best' })).toBeNull();
  });

  test('missed forced mate', () => {
    const r = explainMistake({ ...base, isMissedWin: true, bestLeadsToMate: true });
    expect(r).toContain('forced checkmate');
    expect(r).toContain('e4');
  });

  test('missed win (not mate)', () => {
    const r = explainMistake({ ...base, isMissedWin: true, bestLeadsToMate: false });
    expect(r).toMatch(/strong move|advantage/i);
    expect(r).toContain('e4');
  });

  test('hanging piece: undefended bishop lost to a pawn capture', () => {
    // White just played a bishop to e4; it is undefended and Black plays dxe4.
    const ctx: ReasonCtx = {
      ...base,
      fenAfter: '4k3/8/8/3p4/4B3/8/8/4K3 b - - 0 1',
      playedSan: 'Be4',
      bestMoveSan: 'Bd3',
      classification: 'blunder',
      opponentReplySan: 'dxe4',
    };
    const r = explainMistake(ctx);
    expect(r).toContain('bishop');
    expect(r).toContain('hanging');
    expect(r).toContain('dxe4');
  });

  test('fallback names the better move', () => {
    expect(explainMistake(base)).toBe('A stronger move was e4.');
  });

  test('fallback without a better move', () => {
    expect(explainMistake({ ...base, bestMoveSan: null })).toBe(
      'A stronger move was available.',
    );
  });
});
