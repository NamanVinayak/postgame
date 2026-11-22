import { describe, expect, it } from 'vitest';
import { evalToWinPct } from '../../../src/analysis/winPct';
import type { Engine, Evaluation } from '../../../src/services/engine/types';
import type { Classification } from '../../../src/types';
import { DISPLAY_CFG } from '../config';
import { diagnose, type Diagnosis } from '../diagnosis/diagnose';
import { fixtureGame, shuffleSans } from '../diagnosis/testGames';
import { deepPositionFacts, examplePositions, positionFacts } from './explain';

// Made-up game: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.Ng5 d5 5.exd5 Nxd5. Ply 5 is Black's ...Nf6.
// Win numbers are fixture values (White's win % after each ply), not engine output.
const SANS = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Nxd5'];
const WINS = [52, 50, 54, 52, 55, 66, 60, 70, 62, 72];
const FEN_BEFORE_5 = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const FEN_AFTER_5 = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const GAME_ID = 'https://example.test/game/1';

function italian(over: { best5?: string | null; cls5?: Classification; reason5?: string | null } = {}) {
  const best = SANS.map(() => undefined as string | null | undefined);
  best[5] = over.best5 === undefined ? 'Be7' : over.best5;
  const cls = SANS.map(() => undefined as Classification | undefined);
  cls[5] = over.cls5;
  const c = fixtureGame({ id: GAME_ID, sans: SANS, wins: WINS, best, cls, myColor: 'black' });
  c.analysis.plies[5].reason = over.reason5 === undefined ? 'A stronger move was Be7.' : over.reason5;
  c.analysis.plies[6].bestLineSan = ['Ng5', 'd5', 'exd5', 'Na5'];
  return c;
}

const ev = (cp: number | null, mate: number | null, pvUci: string[] | null): Evaluation => ({
  cp,
  mate,
  bestMoveUci: pvUci?.[0] ?? null,
  secondBest: null,
  pvUci,
});

/** An engine that answers only the FENs it was given and records every search. */
function scriptedEngine(byFen: Record<string, Evaluation>): Engine & { calls: { fen: string; ms: number }[] } {
  const calls: { fen: string; ms: number }[] = [];
  return {
    calls,
    async evaluate(fen, ms) {
      calls.push({ fen, ms });
      const e = byFen[fen];
      if (!e) throw new Error(`unexpected search: ${fen}`);
      return e;
    },
  };
}

describe('positionFacts (from the cache)', () => {
  it('positionFactsReadsRefutationFromNextPly', () => {
    const f = positionFacts(italian(), 5);
    // The opponent's best line after the played move is the next ply's best line.
    expect(f.refutationSan).toEqual(['Ng5', 'd5', 'exd5', 'Na5']);
    expect(f).toMatchObject({
      gameId: GAME_ID,
      ply: 5,
      fenBefore: FEN_BEFORE_5,
      fenAfter: FEN_AFTER_5,
      mover: 'black',
      playedSan: 'Nf6',
      playedUci: 'g8f6',
      bestSan: 'Be7',
      bestUci: 'f8e7',
      gameUrl: GAME_ID,
    });
  });

  it('win % is the mover’s, before and after the move', () => {
    const f = positionFacts(italian(), 5);
    // Black moved: White had 55 before and 66 after, so Black had 45 and 34.
    expect(f.winBefore).toBe(45);
    expect(f.winAfter).toBe(34);
    const first = positionFacts(italian(), 0);
    expect(first.winBefore).toBe(50); // nothing is cached for the start position
    expect(first.winAfter).toBe(52);
  });

  it('has no refutation on the last move, and rejects a ply outside the game', () => {
    expect(positionFacts(italian(), 9).refutationSan).toBeNull();
    expect(() => positionFacts(italian(), 10)).toThrow(/ply/);
    expect(() => positionFacts(italian(), -1)).toThrow(/ply/);
  });
});

describe('deepPositionFacts (re-searched for display)', () => {
  const BEFORE = ev(80, null, ['f8c5', 'c2c3', 'g8f6']); // Black to move: +80 for Black
  const AFTER = ev(150, null, ['f3g5', 'd7d5', 'e4d5']); // White to move: +150 for White

  it('searches fenBefore and fenAfter once each, at display depth', async () => {
    const engine = scriptedEngine({ [FEN_BEFORE_5]: BEFORE, [FEN_AFTER_5]: AFTER });
    await deepPositionFacts(italian(), 5, engine);
    expect(engine.calls).toEqual([
      { fen: FEN_BEFORE_5, ms: DISPLAY_CFG.movetimeMs },
      { fen: FEN_AFTER_5, ms: DISPLAY_CFG.movetimeMs },
    ]);
  });

  it('deepWinIsFromMoversSide: both win % are Black’s when Black moved', async () => {
    const engine = scriptedEngine({ [FEN_BEFORE_5]: BEFORE, [FEN_AFTER_5]: AFTER });
    const f = await deepPositionFacts(italian(), 5, engine);
    expect(f.winBefore).toBeCloseTo(evalToWinPct(80, null), 6); // side to move = Black
    expect(f.winAfter).toBeCloseTo(100 - evalToWinPct(150, null), 6); // side to move = White, flipped
    expect(f.winBefore).toBeGreaterThan(50);
    expect(f.winAfter).toBeLessThan(50);
  });

  it('takes best move, best line and refutation from the deep search, and rewrites the reason', async () => {
    const engine = scriptedEngine({ [FEN_BEFORE_5]: BEFORE, [FEN_AFTER_5]: AFTER });
    const f = await deepPositionFacts(italian(), 5, engine);
    expect(f.bestSan).toBe('Bc5');
    expect(f.bestUci).toBe('f8c5');
    expect(f.bestLineSan).toEqual(['Bc5', 'c3', 'Nf6']);
    expect(f.refutationSan).toEqual(['Ng5', 'd5', 'exd5']);
    // Loss ≈ 57.3 − 36.4 ≈ 21 points: a blunder at depth. The cached reason named the quick
    // search's move (Be7); the shown reason must name the deep one.
    expect(f.classification).toBe('blunder');
    expect(f.reason).toContain('Bc5');
    expect(f.reason).not.toContain('Be7');
    expect(f).toMatchObject({ fenBefore: FEN_BEFORE_5, fenAfter: FEN_AFTER_5, playedUci: 'g8f6', mover: 'black' });
  });

  it('bestIsNullOnlyWhenPlayedIsEnginesBest', async () => {
    // Cached as "best" with no better move, but the deep search prefers Bc5 by a hair:
    // the board must still show Bc5 as the best move.
    const nearlyEqual = scriptedEngine({
      [FEN_BEFORE_5]: ev(20, null, ['f8c5', 'c2c3']),
      [FEN_AFTER_5]: ev(-18, null, ['d2d3', 'f8c5']),
    });
    const close = await deepPositionFacts(italian({ best5: null, cls5: 'best', reason5: null }), 5, nearlyEqual);
    expect(close.bestUci).toBe('f8c5');
    expect(close.bestSan).toBe('Bc5');

    // The deep search's own first choice is the played move: best is null, the line stays.
    const same = scriptedEngine({
      [FEN_BEFORE_5]: ev(20, null, ['g8f6', 'f3g5', 'd7d5']),
      [FEN_AFTER_5]: ev(-20, null, ['f3g5', 'd7d5']),
    });
    const played = await deepPositionFacts(italian(), 5, same);
    expect(played.bestUci).toBeNull();
    expect(played.bestSan).toBeNull();
    expect(played.bestLineSan).toEqual(['Nf6', 'Ng5', 'd5']);
    expect(played.classification).toBe('best');
    expect(played.reason).toBeNull();
  });

  it('refuses to guess when the engine gives no usable best move', async () => {
    // Without a best move the board would read "the played move was best"; fail instead.
    const none = scriptedEngine({ [FEN_BEFORE_5]: ev(20, null, null), [FEN_AFTER_5]: AFTER });
    await expect(deepPositionFacts(italian(), 5, none)).rejects.toThrow(/no usable best move/);
    const illegal = scriptedEngine({ [FEN_BEFORE_5]: ev(20, null, ['e1e8']), [FEN_AFTER_5]: AFTER });
    await expect(deepPositionFacts(italian(), 5, illegal)).rejects.toThrow(/no usable best move/);
  });

  it('does not search after checkmate: the mover has 100%', async () => {
    // 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6 4.Qxf7#: ply 6 mates.
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];
    const c = fixtureGame({ id: 'https://example.test/game/mate', sans, wins: [50, 50, 50, 50, 50, 80, 100] });
    const fenBefore = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    const engine = scriptedEngine({ [fenBefore]: ev(null, 1, ['h5f7']) });
    const f = await deepPositionFacts(c, 6, engine);
    expect(engine.calls.map((x) => x.fen)).toEqual([fenBefore]);
    expect(f.winBefore).toBe(100);
    expect(f.winAfter).toBe(100);
    expect(f.refutationSan).toBeNull();
    expect(f.bestUci).toBeNull();
  });
});

describe('examplePositions', () => {
  /** White's win % after each of 80 knight-shuffle plies, with drops at the given plies. */
  function winsWithDrops(drops: Record<number, number>): number[] {
    let w = 50;
    return Array.from({ length: 80 }, (_, i) => {
      if (drops[i] !== undefined) w = drops[i];
      return w;
    });
  }
  const SHUFFLE = shuffleSans(80);
  const game = (id: string, drops: Record<number, number>, username = 'alice') =>
    fixtureGame({ id, sans: SHUFFLE, wins: winsWithDrops(drops), username });

  // alice is White. A: her middlegame mistake at ply 30 (−15), then bob blunders at 31 (−50 for him).
  // B: her middlegame mistakes at ply 40 (−30) and ply 50 (−10). C: her opening blunder at ply 4 (−40).
  const A = game('https://example.test/game/A', { 30: 35, 31: 85 });
  const B = game('https://example.test/game/B', { 40: 20, 50: 10 });
  const C = game('https://example.test/game/C', { 4: 10 });
  const OTHER = game('https://example.test/game/D', { 30: 5 }, 'carol');
  const games = [A, B, C, OTHER];
  const withFocus = (focus: Diagnosis['focus']): Diagnosis => ({ ...diagnose(games, ['alice']), focus });

  it('picks the player’s worst mistakes in the focus area, one per game, worst first', () => {
    const ex = examplePositions(withFocus({ kind: 'area', area: 'middlegame' }), games, 5);
    expect(ex.map((f) => [f.gameId, f.ply])).toEqual([
      ['https://example.test/game/B', 40],
      ['https://example.test/game/A', 30],
    ]);
    expect(ex.every((f) => f.mover === 'white')).toBe(true);
    expect(examplePositions(withFocus({ kind: 'area', area: 'middlegame' }), games, 1)).toHaveLength(1);
  });

  it('uses the repeated positions when they are the focus', () => {
    // alice reaches the position after 1.e4 e5 2.Nf3 Nc6 in three games and goes wrong in two.
    const open = (id: string, third: string, drop: number) =>
      fixtureGame({ id, sans: ['e4', 'e5', 'Nf3', 'Nc6', third, 'Nf6'], wins: [50, 50, 50, 50, 50 - drop, 50 - drop] });
    const rep = [
      open('https://example.test/game/r1', 'Bc4', 8),
      open('https://example.test/game/r2', 'Bb5', 12),
      open('https://example.test/game/r3', 'd4', 0),
    ];
    const d = diagnose(rep, ['alice']);
    expect(d.focus?.kind).toBe('repeated');
    const ex = examplePositions(d, rep, 3);
    expect(ex.map((f) => [f.gameId, f.ply, f.playedSan])).toEqual([['https://example.test/game/r2', 4, 'Bb5']]);
  });

  it('gives nothing without a focus', () => {
    expect(examplePositions(withFocus(null), games, 3)).toEqual([]);
  });
});
