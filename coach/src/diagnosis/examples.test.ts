import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { Outcome } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { examplesPage, type ExampleRow, type ExamplesPage } from './examples';
import { leakReport } from './leaks';
import { positionKey } from './repeated';
import { fixtureGame, shuffleSans, type FixtureOpts } from './testGames';

// Made-up games: alice is White unless said otherwise; her opponent is "bob".
function game(o: FixtureOpts & { outcome?: Outcome; at?: Record<number, number> }): CachedGame {
  let w = 50;
  const wins = o.wins ?? o.sans.map((_, i) => (w = o.at?.[i] ?? w));
  const c = fixtureGame({ ...o, wins });
  return { ...c, game: { ...c.game, outcome: o.outcome ?? 'loss', opponent: { username: 'bob', rating: 1432 } } };
}
const SANS = shuffleSans(60);
const page = (games: CachedGame[], req: Parameters<typeof examplesPage>[2]): ExamplesPage => {
  const p = examplesPage(games, ['alice'], req);
  if ('error' in p) throw new Error(p.error);
  return p;
};

describe('thrown wins', () => {
  it('thrownWinsSlipIsBiggestDropAfterWinning', () => {
    const g = game({
      id: 'https://example.test/game/t1',
      sans: SANS,
      endTime: 1_700_000_300,
      // ply 2: alice drops 20 before she is clearly winning (ignored); then 85 before her moves at
      // plies 6 and 8 (clearly winning from ply 8); then drops of 10 (ply 12) and 30 (ply 20).
      at: { 2: 30, 5: 85, 12: 75, 20: 45 },
    });
    const p = page([g], { source: 'thrownWins' });
    expect(p).toMatchObject({ kind: 'examples', source: 'thrownWins', title: 'Games you were winning and lost', total: 1, offset: 0, limit: 10, numbersLabel: 'quick check' });
    expect(p.examples[0]).toMatchObject({ slipPly: 20, slipMoveNo: 11, quickWinBefore: 75, quickWinAfter: 45, result: 'loss', myColor: 'white' });

    // Only games clearly winning (two own moves in a row at 75+) and then lost; newest first.
    const won = game({ id: 'https://example.test/game/t2', sans: SANS, at: { 5: 85, 20: 45 }, outcome: 'win', endTime: 1_700_000_400 });
    const once = game({ id: 'https://example.test/game/t3', sans: SANS, at: { 5: 85, 7: 60, 20: 45 }, endTime: 1_700_000_500 });
    const older = game({ id: 'https://example.test/game/t4', sans: SANS, at: { 5: 85, 30: 20 }, endTime: 1_700_000_100 });
    // Lost on time while still winning: no drop at all, so the slip is the first move once clearly winning.
    const flagged = game({ id: 'https://example.test/game/t5', sans: SANS, at: { 5: 85 }, endTime: 1_700_000_200 });
    const all = [older, won, g, once, flagged];
    const p2 = page(all, { source: 'thrownWins' });
    expect(p2.examples.map((e) => [e.gameId.slice(-2), e.slipPly])).toEqual([['t1', 20], ['t5', 8], ['t4', 30]]);
    // The same rule as the report's conversion: the total is the lost-from-winning count.
    expect(p2.total).toBe(leakReport(all, ['alice']).conversion.lost);
  });

  it('thrownWinsForBlack', () => {
    // alice is Black: White's win % at 15 means she is at 85.
    const g = game({ id: 'https://example.test/game/b1', sans: SANS, myColor: 'black', at: { 0: 15, 15: 60 } });
    const row = page([g], { source: 'thrownWins' }).examples[0];
    expect(row).toMatchObject({ myColor: 'black', slipPly: 15, slipMoveNo: 8, quickWinBefore: 85, quickWinAfter: 40 });
    expect(row.timeline[0]).toBe(85); // her win %, not White's
  });
});

describe('leak examples', () => {
  it('leakExamplesOneRowPerGameNewestFirst', () => {
    // Middlegame (move 11+): the old game drops 12 (ply 24) and 30 (ply 28); the new one 15 (ply 30).
    const old = game({ id: 'https://example.test/game/l1', sans: SANS, at: { 24: 38, 25: 38, 28: 8 }, endTime: 1_700_000_100 });
    const fresh = game({ id: 'https://example.test/game/l2', sans: SANS, at: { 30: 35 }, endTime: 1_700_000_200 });
    // A drop of 9 is not a costly move; an opening drop is another situation.
    const small = game({ id: 'https://example.test/game/l3', sans: SANS, at: { 4: 20, 5: 50, 24: 41 }, endTime: 1_700_000_300 });
    const p = page([old, fresh, small], { source: 'middlegame' });
    expect(p.title).toBe('Balanced middlegames: your costliest move in each game');
    expect(p.examples.map((e) => [e.gameId.slice(-2), e.slipPly, e.quickWinBefore - e.quickWinAfter])).toEqual([
      ['l2', 30, 15],
      ['l1', 28, 30],
    ]);
    expect(page([old, fresh, small], { source: 'opening' }).examples.map((e) => [e.gameId.slice(-2), e.slipPly])).toEqual([['l3', 4]]);
  });
});

describe('quick fix examples', () => {
  it('quickFixListsTheGamesThatReachedThePosition', () => {
    // alice reaches the position after 1.e4 e5 2.Nf3 Nc6 in three games and goes wrong in two.
    const open = ['e4', 'e5', 'Nf3', 'Nc6'];
    const mk = (n: number, move: string, loss: number) =>
      game({ id: `https://example.test/game/q${n}`, sans: [...open, move, 'Nf6'], wins: [50, 50, 50, 50, 50 - loss, 50 - loss], endTime: 1_700_000_000 + n });
    const games = [mk(1, 'Bc4', 12), mk(2, 'Na3', 15), mk(3, 'Bb5', 0)];
    const key = positionKey(fenOf(open));
    const p = page(games, { source: 'quickFix', key });
    expect(p).toMatchObject({ source: 'quickFix', key, title: 'Games that reached this position', total: 3 });
    expect(p.examples.map((e) => [e.gameId.slice(-2), e.slipPly, e.playedSan])).toEqual([['q3', 4, 'Bb5'], ['q2', 4, 'Na3'], ['q1', 4, 'Bc4']]);
    // An unknown key (or none) is a clear error, not a crash.
    for (const k of ['nope', undefined]) {
      const bad = examplesPage(games, ['alice'], { source: 'quickFix', key: k });
      expect(bad).toEqual({ error: expect.stringMatching(/position/) });
    }
  });
});

/** The position after `sans`, replayed with chess.js (independent of the code under test). */
function fenOf(sans: string[]): string {
  const b = new Chess();
  for (const m of sans) b.move(m);
  return b.fen();
}

describe('pages and rows', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    game({ id: `https://example.test/game/p${String(i).padStart(2, '0')}`, sans: SANS, at: { 5: 85, 20: 45 }, endTime: 1_700_000_000 + i }),
  );

  it('examplesPaginateAndClampLimit', () => {
    const first = page(many, { source: 'thrownWins', limit: 50 });
    expect(first).toMatchObject({ total: 25, offset: 0, limit: 10 });
    expect(first.examples).toHaveLength(10);
    expect(first.examples[0].gameId.slice(-3)).toBe('p24'); // newest first
    const last = page(many, { source: 'thrownWins', offset: 20, limit: 10 });
    expect(last.examples.map((e) => e.gameId.slice(-3))).toEqual(['p04', 'p03', 'p02', 'p01', 'p00']);
    expect(page(many, { source: 'thrownWins', offset: 30 }).examples).toEqual([]);
    expect(page(many, { source: 'thrownWins', limit: 3, offset: -4 })).toMatchObject({ offset: 0, limit: 3 });
    expect(page(many, { source: 'thrownWins', limit: 0 }).limit).toBe(1);
  });

  it('timelineDownsampledWithSlipIndex', () => {
    // A long game (200 plies): 80 points at most, and the slip's own point is one of them.
    const long = game({ id: 'https://example.test/game/long', sans: shuffleSans(200), at: { 5: 85, 102: 30 }, endTime: 1 });
    const row = page([long], { source: 'thrownWins' }).examples[0];
    expect(row.slipPly).toBe(102);
    expect(row.timeline).toHaveLength(80);
    expect(row.timeline[row.slipIndex]).toBe(row.quickWinAfter);
    expect(row.timeline[row.slipIndex - 1]).toBe(85);
    expect(row.timeline[0]).toBe(50);
    expect(row.timeline.at(-1)).toBe(30);
    // A short game keeps every ply: the index is the ply.
    const short = page([game({ id: 'https://example.test/game/short', sans: SANS, at: { 5: 85, 20: 45 } })], { source: 'thrownWins' }).examples[0];
    expect(short.timeline).toHaveLength(60);
    expect(short.slipIndex).toBe(20);
    expect(short.timeline[20]).toBe(45);
  });

  it('examplesCarryNoBestMove', () => {
    const p = page(many.slice(0, 2), { source: 'thrownWins' });
    const KEYS: (keyof ExampleRow)[] = [
      'gameId', 'gameUrl', 'date', 'opponentRating', 'result', 'myColor', 'slipPly', 'slipMoveNo',
      'fenBefore', 'playedSan', 'playedUci', 'quickWinBefore', 'quickWinAfter', 'timeline', 'slipIndex',
    ];
    for (const e of p.examples) expect(Object.keys(e).sort()).toEqual([...KEYS].sort());
    expect(Object.keys(p).sort()).toEqual(['examples', 'kind', 'limit', 'numbersLabel', 'offset', 'source', 'title', 'total']);
    const json = JSON.stringify(p);
    // The cached quick best move ("Nc3" in these fixtures), any engine line, and the opponent's name never appear.
    expect(json).not.toMatch(/best|Nc3|refutation|bob/i);
    expect(p.examples[0]).toMatchObject({ opponentRating: 1432, date: '2023-11-14', gameUrl: p.examples[0].gameId });
  });
});
