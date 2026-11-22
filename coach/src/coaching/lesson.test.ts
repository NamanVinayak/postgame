import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { evalToWinPct } from '../../../src/analysis/winPct';
import type { Evaluation } from '../../../src/services/engine/types';
import type { Classification } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { DISPLAY_CFG } from '../config';
import { gamePlies } from '../diagnosis/areas';
import type { AreaFinding, Diagnosis } from '../diagnosis/diagnose';
import { positionKey, type RepeatedPosition } from '../diagnosis/repeated';
import { fixtureGame, randomSans } from '../diagnosis/testGames';
import { createDisplayEngine } from '../engine/displayEngine';
import type { PositionFacts } from './positionFacts';
import {
  checkMove,
  DRILLS_PER_POSITION,
  firstTeachable,
  isTeachable,
  practiceExclusions,
  refKey,
  rightSessionsByBoard,
  samePatternPositions,
} from './lesson';
import { emptyStudent, recordAttempt, startSession } from './student';

// Made-up game: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.Ng5 d5. Ply 5 is Black's ...Nf6 (the player is Black).
// Win numbers are fixture values, not engine output.
const SANS = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5'];
const FEN_BEFORE_5 = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const FEN_AFTER_5 = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const after = (san: string) => new Chess(FEN_BEFORE_5).move(san).after;

function italian(): CachedGame {
  const best = SANS.map(() => undefined as string | null | undefined);
  best[5] = 'Be7'; // the quick search's choice; the deep search below prefers Bc5
  const cls = SANS.map(() => undefined as Classification | undefined);
  return fixtureGame({ id: 'https://example.test/game/7', sans: SANS, wins: [52, 50, 54, 52, 55, 66, 60, 70], best, cls, myColor: 'black' });
}

const ev = (cp: number | null, mate: number | null, pvUci: string[] | null): Evaluation => ({
  cp,
  mate,
  bestMoveUci: pvUci?.[0] ?? null,
  secondBest: null,
  pvUci,
});

// Deep answers: Black is +80 before the move (best ...Bc5); after ...Nf6 White is +150.
const DEEP: Record<string, Evaluation> = {
  [FEN_BEFORE_5]: ev(80, null, ['f8c5', 'c2c3', 'g8f6']),
  [FEN_AFTER_5]: ev(150, null, ['f3g5', 'd7d5', 'e4d5']),
  [after('h6')]: ev(120, null, ['d2d4', 'e5d4']),
  [after('Be7')]: ev(-60, null, ['d2d4', 'd7d6']),
};

/**
 * A fake display adapter built the way the real one is: from the settings `createDisplayEngine`
 * gives it. Like the native adapter, it searches for the time it was created with; it also
 * records the time each caller asked for.
 */
function fakeDisplay(byFen: Record<string, Evaluation> = DEEP) {
  const calls: { fen: string; askedMs: number; searchMs: number }[] = [];
  const engine = createDisplayEngine((cfg) => ({
    async evaluate(fen: string, ms: number) {
      calls.push({ fen, askedMs: ms, searchMs: cfg.movetimeMs });
      const e = byFen[fen];
      if (!e) throw new Error(`unexpected search: ${fen}`);
      return e;
    },
  }));
  return { engine, calls };
}

const winBlackBefore = evalToWinPct(80, null);
const winBlackAfterNf6 = 100 - evalToWinPct(150, null);

describe('checkMove', () => {
  it('checkMoveIllegalIsReported: an illegal move gives legal: false and never calls the engine', async () => {
    for (const bad of ['Ke2', 'Qxf7', 'e4', 'xyz', '']) {
      const { engine, calls } = fakeDisplay();
      const r = await checkMove(italian(), 5, bad, engine);
      expect(r.legal).toBe(false);
      expect(r.playedInGame).toBe('Nf6');
      expect(calls).toEqual([]);
    }
  });

  it('checkMoveScoresAtDisplayDepth: every search runs at DISPLAY_CFG time; the best move is right with no loss', async () => {
    const { engine, calls } = fakeDisplay();
    const r = await checkMove(italian(), 5, 'Bc5', engine);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.askedMs).toBe(DISPLAY_CFG.movetimeMs);
      expect(c.searchMs).toBe(DISPLAY_CFG.movetimeMs);
    }
    expect(r).toMatchObject({ legal: true, correct: true, lossPts: 0, playedInGame: 'Nf6', isBest: true, isGameMove: false });
    if (!r.legal) throw new Error('unreachable');
    expect(r.attempt).toEqual({ moveSan: 'Bc5', moveUci: 'f8c5' });
    // The best move keeps the position's value; no extra search is made for it.
    expect(r.attemptWin).toBe(winBlackBefore);
    expect(r.bestWin).toBe(winBlackBefore);
    expect(calls.map((c) => c.fen)).toEqual([FEN_BEFORE_5, FEN_AFTER_5]);
    // The facts are the deep ones (the cached quick best move was Be7).
    expect(r.facts).toMatchObject({ bestSan: 'Bc5', bestUci: 'f8c5', playedSan: 'Nf6' });
  });

  it('scores a different move by searching the position after it, from the mover’s side', async () => {
    const { engine, calls } = fakeDisplay();
    const r = await checkMove(italian(), 5, 'h6', engine);
    if (!r.legal) throw new Error('expected legal');
    const win = 100 - evalToWinPct(120, null);
    expect(r.attemptWin).toBeCloseTo(win, 6);
    expect(r.lossPts).toBeCloseTo(winBlackBefore - win, 6);
    expect(r.correct).toBe(false);
    expect(r.attemptRefutationSan).toEqual(['d4', 'exd4']);
    expect(calls.map((c) => c.fen)).toEqual([FEN_BEFORE_5, FEN_AFTER_5, after('h6')]);

    // A move within REPEAT_CFG.wrongLossPts (5) of the best counts as right.
    const close = await checkMove(italian(), 5, 'Be7', fakeDisplay().engine);
    if (!close.legal) throw new Error('expected legal');
    expect(close.lossPts).toBeGreaterThan(0);
    expect(close.lossPts).toBeLessThanOrEqual(5);
    expect(close.correct).toBe(true);
  });

  it('the game move reuses the deep facts (no third search); typed forms are read like the board’s', async () => {
    const { engine, calls } = fakeDisplay();
    const r = await checkMove(italian(), 5, 'g8f6', engine); // UCI, as a player might type it
    if (!r.legal) throw new Error('expected legal');
    expect(r).toMatchObject({ isGameMove: true, isBest: false, correct: false, attempt: { moveSan: 'Nf6', moveUci: 'g8f6' } });
    expect(r.attemptWin).toBe(winBlackAfterNf6);
    expect(r.attemptRefutationSan).toEqual(['Ng5', 'd5', 'exd5']);
    expect(calls).toHaveLength(2);
    const annotated = await checkMove(italian(), 5, ' Bc5!? ', fakeDisplay().engine);
    expect(annotated).toMatchObject({ legal: true, attempt: { moveSan: 'Bc5', moveUci: 'f8c5' } });
  });

  it('castling is the king’s two-square move, as the board widget sends it', async () => {
    // White to move at ply 6 (after 3...Nf6), castling allowed. Not the player's move, but checkMove only scores.
    const c = fixtureGame({ id: 'https://example.test/game/8', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O', 'Bc5'] });
    const fen = gamePlies(c)![6].fenBefore;
    const byFen = {
      [fen]: ev(30, null, ['e1g1']),
      [new Chess(fen).move('O-O').after]: ev(-30, null, ['f8c5']),
    };
    const r = await checkMove(c, 6, 'O-O', fakeDisplay(byFen).engine);
    expect(r).toMatchObject({ legal: true, attempt: { moveSan: 'O-O', moveUci: 'e1g1' }, isBest: true });
  });
});

// ---- choosing positions ----

function area(over: Partial<AreaFinding> & Pick<AreaFinding, 'area' | 'label'>): AreaFinding {
  return {
    myRate: 6, oppRate: 5, gapPts: 1, ci95: [-1, 3], ciAdj: [-2, 4], exactP: 0.5,
    games: 40, myGames: 40, oppGames: 40, myMoves: 900, oppMoves: 900, notes: [],
    ...over,
  };
}

function diagnosis(focus: Diagnosis['focus'], repeated: RepeatedPosition[] = []): Diagnosis {
  return {
    usernames: ['alice'],
    timeClass: 'blitz',
    games: 3,
    asOf: 0,
    areas: [area({ area: 'opening', label: 'gap' })],
    repeated,
    focus,
    notes: [],
  };
}

/**
 * A random legal game (seeded) of `plies` moves, alice as White, with serious mistakes by
 * alice at `mistakes` (ply → win-% lost). The first ten moves of a side are its opening.
 */
function mistakeGame(id: string, seed: number, mistakes: Record<number, number>, plies = 40): CachedGame {
  const sans = randomSans(seed, plies);
  const wins = sans.map((_, i) => (mistakes[i] !== undefined ? 50 - mistakes[i] : 50));
  const cls = sans.map((_, i) => (mistakes[i] !== undefined ? ('mistake' as Classification) : undefined));
  return fixtureGame({ id, sans, wins, cls });
}

describe('samePatternPositions', () => {
  // Opening mistakes (alice is White: even plies ≤ 18) and one later mistake outside the opening.
  const g1 = mistakeGame('https://example.test/game/a', 11, { 4: 30, 10: 12, 30: 40 });
  const g2 = mistakeGame('https://example.test/game/b', 12, { 6: 25 });
  const g3 = mistakeGame('https://example.test/game/c', 11, { 4: 30 }); // same moves as g1: same boards
  const games = [g1, g2, g3];
  const keyAt = (c: CachedGame, ply: number) => positionKey(gamePlies(c)![ply].fenBefore);

  it('samePatternExcludesSeen: positions from the focus area only, never an excluded one or its board', () => {
    const d = diagnosis({ kind: 'area', area: 'opening' });
    const all = samePatternPositions(d, games, [], 10);
    // Ply 30 (move 16) is not in the opening; g3's ply 4 is g1's ply 4 again (same board).
    expect(all.map((r) => refKey(r.gameId, r.ply)).sort()).toEqual(
      [refKey(g1.game.id, 4), refKey(g1.game.id, 10), refKey(g2.game.id, 6)].sort(),
    );
    // One per game first, worst first.
    expect(all[0]).toEqual({ gameId: g1.game.id, ply: 4, kind: 'mistake' });
    expect(all[1]).toEqual({ gameId: g2.game.id, ply: 6, kind: 'mistake' });

    const ex = [refKey(g1.game.id, 4), refKey(g2.game.id, 6)];
    const rest = samePatternPositions(d, games, ex, 10);
    expect(rest).toEqual([{ gameId: g1.game.id, ply: 10, kind: 'mistake' }]); // g3's ply 4 is the same board as an excluded one
    for (const r of rest) {
      expect(ex).not.toContain(refKey(r.gameId, r.ply));
      expect(keyAt(g1, 4)).not.toBe(keyAt(games.find((c) => c.game.id === r.gameId)!, r.ply));
    }
    expect(samePatternPositions(d, games, [], 1)).toHaveLength(1);
    expect(samePatternPositions(diagnosis(null), games, [], 5)).toEqual([]);
  });

  it('with a repeated-positions focus, uses those positions’ references (focus first, then the others)', () => {
    const rep = (c: CachedGame, ply: number): RepeatedPosition => ({
      key: keyAt(c, ply),
      fen: gamePlies(c)![ply].fenBefore,
      movesFromStart: [],
      seen: 3,
      wrong: 2,
      avgLossPts: 20,
      usual: [{ move: gamePlies(c)![ply].san, times: 2, lossPts: 20 }],
      best: 'Nc3',
      gameIds: [c.game.id],
    });
    const d = diagnosis({ kind: 'repeated', keys: [keyAt(g2, 6)] }, [rep(g1, 10), rep(g2, 6)]);
    // No opening names in these games, so no opening top-up.
    expect(samePatternPositions(d, games, [], 5)).toEqual([
      { gameId: g2.game.id, ply: 6, kind: 'repeated' },
      { gameId: g1.game.id, ply: 10, kind: 'repeated' },
    ]);
    expect(samePatternPositions(d, games, [refKey(g2.game.id, 6)], 5)).toEqual([{ gameId: g1.game.id, ply: 10, kind: 'repeated' }]);
  });
});

describe('only real mistakes are taught', () => {
  const facts = (over: Partial<PositionFacts>): PositionFacts => ({
    gameId: 'g', ply: 5, fenBefore: FEN_BEFORE_5, fenAfter: FEN_AFTER_5, mover: 'black',
    playedSan: 'Nf6', playedUci: 'g8f6', bestSan: 'Bc5', bestUci: 'f8c5', bestLineSan: ['Bc5'],
    refutationSan: null, winBefore: 60, winAfter: 40, classification: 'blunder', reason: null, gameUrl: 'g',
    ...over,
  });

  it('isTeachable: a single mistake must still be a mistake or blunder on the deeper check', () => {
    expect(isTeachable('mistake', 'mistake', facts({}))).toBe(true);
    // The quick check called it a mistake; the deep check finds only an inaccuracy.
    expect(isTeachable('mistake', 'mistake', facts({ classification: 'inaccuracy', winAfter: 53 }))).toBe(false);
    expect(isTeachable('mistake', 'blunder', facts({ classification: 'best', bestSan: null, bestUci: null, winAfter: 60 }))).toBe(false);
    expect(isTeachable('mistake', 'inaccuracy', facts({ classification: 'mistake', winAfter: 48 }))).toBe(true);
  });

  it('isTeachable: a repeated position needs the game move to lose more than 5 at depth and not be the deep best', () => {
    // The same line checkMove uses: an inaccuracy that loses 7 is still a wrong move there.
    expect(isTeachable('repeated', 'inaccuracy', facts({ classification: 'inaccuracy', winAfter: 53 }))).toBe(true);
    expect(isTeachable('repeated', 'mistake', facts({ classification: 'inaccuracy', winAfter: 53 }))).toBe(true);
    expect(isTeachable('repeated', 'inaccuracy', facts({ classification: 'good', winAfter: 57 }))).toBe(false);
    expect(isTeachable('repeated', 'inaccuracy', facts({ classification: 'inaccuracy', winAfter: 55 }))).toBe(false); // exactly 5
    expect(isTeachable('repeated', 'blunder', facts({ classification: 'best', bestSan: null, bestUci: null, winAfter: 30 }))).toBe(false);
  });

  it('skipsPositionsThatAreNotRealMistakes: deep-checks each candidate in turn and skips the cleared ones', async () => {
    const a = mistakeGame('https://example.test/game/x', 21, { 4: 30 });
    const b = mistakeGame('https://example.test/game/y', 22, { 8: 30 });
    const byId = new Map([a, b].map((c) => [c.game.id, c]));
    const checked: string[] = [];
    const deep = async (c: CachedGame, ply: number): Promise<PositionFacts> => {
      checked.push(refKey(c.game.id, ply));
      // The deeper check clears game x's move, and confirms game y's.
      return c === a
        ? facts({ gameId: c.game.id, ply, classification: 'best', bestSan: null, bestUci: null, winAfter: 60 })
        : facts({ gameId: c.game.id, ply });
    };
    const refs = [
      { gameId: a.game.id, ply: 4 },
      { gameId: 'https://example.test/game/missing', ply: 2 },
      { gameId: b.game.id, ply: 8 },
    ];
    const r = await firstTeachable(refs, (id) => byId.get(id) ?? null, deep, 5);
    expect(r.found).toMatchObject({ ply: 8, facts: { gameId: b.game.id }, kind: 'mistake' });
    expect(r.skipped).toEqual([refs[0], refs[1]]);
    expect(checked).toEqual([refKey(a.game.id, 4), refKey(b.game.id, 8)]);

    // At most `maxChecks` deep checks.
    const capped = await firstTeachable(refs, (id) => byId.get(id) ?? null, deep, 1);
    expect(capped.found).toBeNull();
  });
});

describe('practice top-up for a repeated-position focus', () => {
  const ECO = (slug: string) => `[ECOUrl "https://www.chess.com/openings/${slug}"]\n\n*`;
  const withEco = (c: CachedGame, slug: string) => ((c.game.pgn = ECO(slug)), c);
  // f1/f2 reach the focus position; f2 and s1 are Sicilians, k1 is a Caro-Kann.
  const f1 = withEco(mistakeGame('https://example.test/game/f1', 41, { 6: 20 }), 'Sicilian-Defense-Alapin-Variation');
  const f2 = withEco(mistakeGame('https://example.test/game/f2', 41, { 6: 18, 12: 25 }), 'Sicilian-Defense-Old-Sicilian');
  const s1 = withEco(mistakeGame('https://example.test/game/s1', 42, { 8: 30, 34: 40 }, 50), 'Sicilian-Defense-Bowdler-Attack');
  const k1 = withEco(mistakeGame('https://example.test/game/k1', 43, { 8: 35 }), 'Caro-Kann-Defense');
  const o1 = mistakeGame('https://example.test/game/o1', 44, { 10: 15 }); // another repeated position
  const games = [f1, f2, s1, k1, o1];
  const fact = (c: CachedGame, ply: number) => gamePlies(c)![ply];
  const rep = (c: CachedGame, ply: number, ids: string[]): RepeatedPosition => ({
    key: positionKey(fact(c, ply).fenBefore),
    fen: fact(c, ply).fenBefore,
    movesFromStart: [],
    seen: 3,
    wrong: 2,
    avgLossPts: 15,
    usual: [{ move: fact(c, ply).san, times: 2, lossPts: 15 }],
    best: 'Nc3',
    gameIds: ids,
  });

  it('after the focus positions: the other repeated positions, then early mistakes in games of the same opening family', () => {
    const focusRep = rep(f1, 6, [f1.game.id, f2.game.id]);
    const other = rep(o1, 10, [o1.game.id]);
    const d = diagnosis({ kind: 'repeated', keys: [focusRep.key] }, [other, focusRep]);
    const out = samePatternPositions(d, games, [], 10);
    expect(out[0]).toMatchObject({ kind: 'repeated' });
    expect(positionKey(fact(games.find((c) => c.game.id === out[0].gameId)!, out[0].ply).fenBefore)).toBe(focusRep.key);
    expect(out[1]).toEqual({ gameId: o1.game.id, ply: 10, kind: 'repeated' });
    // Then Sicilian games' mistakes up to move 15, worst first: s1 ply 8 (30), f2 ply 12 (25).
    // Not s1 ply 34 (move 18), not the Caro-Kann, and not the focus board again (f2 ply 6).
    expect(out.slice(2)).toEqual([
      { gameId: s1.game.id, ply: 8, kind: 'mistake' },
      { gameId: f2.game.id, ply: 12, kind: 'mistake' },
    ]);
  });
});

describe('practiceExclusions', () => {
  // h1 and h3 are the same random game (same boards); h2 is another.
  const h1 = mistakeGame('https://example.test/game/h1', 31, { 4: 30 });
  const h2 = mistakeGame('https://example.test/game/h2', 32, { 6: 30 });
  const h3 = mistakeGame('https://example.test/game/h3', 31, { 4: 30 });
  const byId = new Map([h1, h2, h3].map((c) => [c.game.id, c]));
  const tried = (c: CachedGame, ply: number, correct: boolean) => ({ gameId: c.game.id, ply, moveSan: 'x', correct, lossPts: correct ? 0 : 12 });
  const X = () => positionKey(gamePlies(h1)![4].fenBefore);

  it('leaves out this session’s tries and boards whose first try was right in three sessions; brings back the rest', () => {
    expect(DRILLS_PER_POSITION).toBe(3);
    let s = emptyStudent('alice');
    s = recordAttempt(startSession(s, null, 1), tried(h1, 4, true)); // board X: first try right (1)
    s = recordAttempt(s, tried(h2, 6, true)); // board Y right once only
    s = recordAttempt(startSession(s, null, 2), tried(h3, 4, true)); // board X right (2), via another game
    s = recordAttempt(startSession(s, null, 3), tried(h1, 4, false));
    s = recordAttempt(s, tried(h1, 4, true)); // right only after the answer was shown: doesn't count
    s = startSession(s, null, 4); // running now
    s = recordAttempt(s, tried(h2, 10, false));

    expect(rightSessionsByBoard(s, byId).get(X())).toEqual(new Set([0, 1]));
    expect(practiceExclusions(s, 3, byId)).toEqual([refKey(h2.game.id, 10)]);

    // A third session whose first try at X is right: X is learned and left out wherever it was tried.
    s = recordAttempt(startSession(s, null, 5), tried(h3, 4, true));
    const ex = practiceExclusions(s, 4, byId);
    expect(new Set(ex)).toEqual(new Set([refKey(h1.game.id, 4), refKey(h3.game.id, 4)]));
    expect(ex).not.toContain(refKey(h2.game.id, 6)); // right once: practised again later
  });
});
