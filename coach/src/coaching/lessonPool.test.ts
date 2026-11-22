import { describe, expect, it } from 'vitest';
import type { Outcome } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { gamePlies } from '../diagnosis/areas';
import { positionKey } from '../diagnosis/repeated';
import { fixtureGame, randomSans } from '../diagnosis/testGames';
import { refKey } from './lesson';
import {
  drillsDone,
  lessonCandidates,
  lessonPrompt,
  teachableAs,
  walkLessonPool,
  type LessonRef,
} from './lessonPool';
import type { PositionFacts } from './positionFacts';
import type { StudentFile } from './student';

// Made-up games (alice is White): random legal moves, so every game's positions differ.
function game(id: number, wins: Record<number, number>, o: { outcome?: Outcome; endTime?: number; plies?: number } = {}): CachedGame {
  const sans = randomSans(1000 + id, o.plies ?? 40);
  let w = 50;
  const series = sans.map((_, i) => (w = wins[i] ?? w));
  const c = fixtureGame({ id: `g${id}`, sans, wins: series, endTime: o.endTime ?? 1_700_000_000 + id });
  return { ...c, game: { ...c.game, outcome: o.outcome ?? 'loss' } };
}

const board = (c: CachedGame, ply: number) => positionKey(gamePlies(c)![ply].fenBefore);

function facts(over: Partial<PositionFacts> = {}): PositionFacts {
  return {
    gameId: 'g', ply: 0, fenBefore: '8/8/8/8/8/8/8/K6k w - - 0 1', fenAfter: '8/8/8/8/8/8/8/K6k b - - 1 1', mover: 'white',
    playedSan: 'Kb1', playedUci: 'a1b1', bestSan: 'Ka2', bestUci: 'a1a2', bestLineSan: ['Ka2'], refutationSan: null,
    winBefore: 85, winAfter: 40, classification: 'blunder', reason: null, gameUrl: 'g',
    ...over,
  };
}

describe('lessonCandidates', () => {
  it('keepTheWinPoolIsTheCandidatesInOrderOneBoardEach', () => {
    // alice at 85 before her moves at plies 2 and 4, then a 25-point drop with her move at ply 6.
    const slip = { 1: 85, 6: 60 };
    const lostOld = game(1, slip, { outcome: 'loss', endTime: 100 });
    const lostNew = game(2, slip, { outcome: 'loss', endTime: 200 });
    const won = game(3, slip, { outcome: 'win', endTime: 300 });
    const pool = lessonCandidates({ kind: 'keepTheWin' }, [won, lostOld, lostNew], ['alice']);
    expect(pool.map((r) => [r.gameId, r.ply, r.kind])).toEqual([
      ['g2', 6, 'keepTheWin'],
      ['g1', 6, 'keepTheWin'],
      ['g3', 6, 'keepTheWin'],
    ]);
    expect(pool[0].board).toBe(board(lostNew, 6));
    // The same board twice is one candidate (the first).
    const again = { ...lostOld, game: { ...lostOld.game, id: 'g9', endTime: 50 } };
    expect(lessonCandidates({ kind: 'keepTheWin' }, [lostOld, again], ['alice']).map((r) => r.gameId)).toEqual(['g1']);
  });

  it('leakPoolIsEachGamesBiggestFirstNewestGameFirst', () => {
    // Middlegame (move 11+) drops: old game 12 then 30; new game 15.
    const old = game(1, { 24: 38, 25: 38, 28: 8 }, { endTime: 100 });
    const fresh = game(2, { 30: 35 }, { endTime: 200 });
    const pool = lessonCandidates({ kind: 'leak', key: 'middlegame' }, [old, fresh], ['alice']);
    expect(pool.map((r) => [r.gameId, r.ply, r.kind])).toEqual([
      ['g2', 30, 'mistake'], // newest game's biggest
      ['g1', 28, 'mistake'], // older game's biggest (30 points)
      ['g1', 24, 'mistake'], // then each game's second biggest
    ]);
    // The clock focus uses the clock situation's moves (none here).
    expect(lessonCandidates({ kind: 'clock' }, [old, fresh], ['alice'])).toEqual([]);
  });

  it('openingPoolPutsRepeatedPositionsFirst', () => {
    // A costly opening move at ply 4 (move 3) in g1; g2's ply 6 is a repeated position's sighting.
    const g1 = game(1, { 4: 30 });
    const g2 = game(2, {});
    const pool = lessonCandidates({ kind: 'leak', key: 'opening' }, [g1, g2], ['alice'], [
      { key: board(g2, 6), ref: { gameId: 'g2', ply: 6 } },
      { key: 'gone', ref: null },
    ]);
    expect(pool.map((r) => [r.gameId, r.ply, r.kind])).toEqual([
      ['g2', 6, 'repeated'],
      ['g1', 4, 'mistake'],
    ]);
    // Other situations don't take the repeated positions.
    expect(lessonCandidates({ kind: 'leak', key: 'middlegame' }, [g1, g2], ['alice'], [{ key: 'k', ref: { gameId: 'g2', ply: 6 } }])).toEqual([]);
  });
});

describe('teachableAs and lessonPrompt', () => {
  it('keepTheWinNeedsWinningAtDepthAndAMistakeAgainstTheDeepBest', () => {
    expect(teachableAs('keepTheWin', 'blunder', facts())).toBe(true);
    // No longer winning at depth (74.9 < 75): not a keep-the-win position.
    expect(teachableAs('keepTheWin', 'blunder', facts({ winBefore: 74.9, winAfter: 40 }))).toBe(false);
    // Only an inaccuracy at depth, or the deep best itself: not asked.
    expect(teachableAs('keepTheWin', 'mistake', facts({ winAfter: 78, classification: 'inaccuracy' }))).toBe(false);
    expect(teachableAs('keepTheWin', 'mistake', facts({ bestSan: null, bestUci: null, classification: 'best' }))).toBe(false);
    // A costly move needs no winning position; a repeated position only the 5-point line.
    expect(teachableAs('mistake', 'mistake', facts({ winBefore: 50, winAfter: 35, classification: 'mistake' }))).toBe(true);
    expect(teachableAs('repeated', 'inaccuracy', facts({ winBefore: 50, winAfter: 43, classification: 'inaccuracy' }))).toBe(true);
    expect(teachableAs('mistake', 'inaccuracy', facts({ winBefore: 50, winAfter: 43, classification: 'inaccuracy' }))).toBe(false);
  });

  it('keepTheWinPromptOnlyWhenWinningAtDepth', () => {
    expect(lessonPrompt(facts({ winBefore: 75 }))).toBe("You're winning here. Find the move that keeps it.");
    expect(lessonPrompt(facts({ winBefore: 74.9 }))).toBe('Find a better move here.');
  });
});

describe('walkLessonPool', () => {
  const games = Array.from({ length: 12 }, (_, i) => game(i, { 1: 85, 6: 55 }));
  const byId = new Map(games.map((c) => [c.game.id, c]));
  const pool = lessonCandidates({ kind: 'keepTheWin' }, games, ['alice']);

  it('capCountsOnlyNewDeepChecks', async () => {
    const deepCalls: string[] = [];
    const store = new Map<string, PositionFacts>();
    const opts = (want: number) => ({
      want,
      maxChecks: 8,
      load: (id: string) => byId.get(id) ?? null,
      known: (r: { gameId: string; ply: number }) => store.get(refKey(r.gameId, r.ply)),
      deep: async (c: CachedGame, ply: number) => {
        deepCalls.push(c.game.id);
        // Every position held up at depth except the oldest game's (the last in the pool).
        const f = c.game.id === 'g0' ? facts() : facts({ bestSan: null, bestUci: null, classification: 'best' });
        store.set(refKey(c.game.id, ply), f);
        return f;
      },
    });
    expect(pool.map((r) => r.gameId)).toEqual(['g11', 'g10', 'g9', 'g8', 'g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1', 'g0']);
    const first = await walkLessonPool(pool, opts(3));
    expect(first).toMatchObject({ found: [], checks: 8, capped: true });
    // The next walk re-reads the first eight for free and checks the rest.
    const second = await walkLessonPool(pool, opts(3));
    expect(second.checks).toBe(4);
    expect(second.capped).toBe(false);
    expect(second.found.map((f) => f.ref.gameId)).toEqual(['g0']);
    expect(deepCalls).toHaveLength(12);
  });

  it('skipsExcludedPositionsAndBoardsAndStopsAtWant', async () => {
    const exclude = { refs: new Set([refKey(pool[0].gameId, pool[0].ply)]), boards: new Set([pool[1].board]) };
    const walk = await walkLessonPool(pool, {
      want: 2,
      maxChecks: 8,
      load: (id) => byId.get(id) ?? null,
      known: () => undefined,
      deep: async () => facts(),
      exclude,
    });
    expect(walk.found.map((f) => f.ref.gameId)).toEqual([pool[2].gameId, pool[3].gameId]);
    expect(walk.checks).toBe(2);
  });
});

describe('drillsDone', () => {
  const now = Date.UTC(2026, 10, 22, 12);
  const day = 24 * 60 * 60 * 1000;
  const pool: LessonRef[] = [
    { gameId: 'g1', ply: 6, kind: 'keepTheWin', board: 'b1' },
    { gameId: 'g2', ply: 8, kind: 'keepTheWin', board: 'b2' },
  ];
  const tried = (gameId: string, ply: number, key: string, correct = false) => ({ gameId, ply, key, moveSan: 'a3', correct, lossPts: 20 });
  const student: StudentFile = {
    username: 'alice',
    createdAt: 0,
    sessions: [
      { at: now - 9 * day, focus: null, tried: [tried('g2', 8, 'b2')], thinkingNotes: [], rule: null }, // too old
      {
        at: now - 2 * day, focus: 'keep the win', thinkingNotes: [], rule: null,
        tried: [
          tried('g1', 6, 'b1'),
          tried('g1', 6, 'b1', true), // a second try at the same board: not a first try
          tried('x', 3, 'other'), // not in the pool
          tried('ex', 40, 'b2'), // from an example: its board is in the pool
        ],
      },
      { at: now - day, focus: 'keep the win', thinkingNotes: [], rule: null, tried: [tried('g1', 6, 'b1')] }, // the same board again
    ],
  };

  it('drillsDoneCountsDistinctPoolBoardsFromFirstTriesThisWeek', () => {
    expect(drillsDone(student, pool, () => null, now)).toBe(2);
    expect(drillsDone(student, pool, () => null, now + 6 * day)).toBe(1); // only the last session is still this week
    expect(drillsDone(undefined, pool, () => null, now)).toBe(0);
    // Older entries without a key: the board is looked up.
    const old: StudentFile = { ...student, sessions: [{ at: now, focus: null, tried: [{ gameId: 'g2', ply: 8, moveSan: 'a3', correct: true, lossPts: 0 }], thinkingNotes: [], rule: null }] };
    expect(drillsDone(old, pool, (g, p) => (g === 'g2' && p === 8 ? 'b2' : null), now)).toBe(1);
  });
});
