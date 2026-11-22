import { describe, expect, it } from 'vitest';
import type { Outcome } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { LEAK_CFG, STATS_CFG } from '../config';
import {
  LEAK_KEYS,
  chooseLeakFocus,
  eloForScoreGain,
  keepTheWinCandidates,
  leakCategory,
  leakReport,
  type Conversion,
  type Leak,
  type LeakKey,
  type TimeLosses,
} from './leaks';
import { fixtureGame, randomSans, shuffleSans, testRng, type FixtureOpts } from './testGames';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROOKS = 'r3k3/8/8/8/8/8/8/4K2R w - - 0 40';

/** A fixture game with a result and, optionally, a PGN Termination header. */
function game(o: FixtureOpts & { outcome?: Outcome; termination?: string }): CachedGame {
  const c = fixtureGame(o);
  const pgn = o.termination ? `[Event "x"]\n[Termination "${o.termination}"]\n\n*` : c.game.pgn;
  return { ...c, game: { ...c.game, outcome: o.outcome ?? 'draw', pgn } };
}

/** White's win % after each ply of a 40-ply knight shuffle: `at` maps ply → value, held until changed. */
function winsFrom(at: Record<number, number>, plies = 40): number[] {
  let w = 50;
  return Array.from({ length: plies }, (_, i) => (w = at[i] ?? w));
}

const SANS = shuffleSans(40);

describe('leakCategory', () => {
  it('categoryOrderIsPrimary', () => {
    // low clock beats winning and first moves
    expect(leakCategory(START, 4, 80, 10, 180)).toBe('clock');
    // already winning beats first moves and endgame material
    expect(leakCategory(ROOKS, 4, 80, 150, 180)).toBe('winning');
    // already losing beats first moves
    expect(leakCategory(START, 4, 20, 150, 180)).toBe('losing');
    // first 10 moves beat endgame material
    expect(leakCategory(ROOKS, 15, 50, 150, 180)).toBe('opening');
    expect(leakCategory(ROOKS, 79, 50, 150, 180)).toBe('endgame');
    expect(leakCategory(START, 30, 50, 150, 180)).toBe('middlegame');
    // edges
    expect(leakCategory(START, 30, 75, 150, 180)).toBe('winning');
    expect(leakCategory(START, 30, 25, 150, 180)).toBe('losing');
    expect(leakCategory(START, 30, 50, 30, 180)).toBe('middlegame'); // not < 30 s
    expect(leakCategory(START, 30, 50, 45, 600)).toBe('clock'); // 10% of 600 s = 60 s
    expect(leakCategory(START, 30, 50, null, 180)).toBe('middlegame');
    expect(leakCategory(START, 30, 50, 0, 0)).toBe('middlegame'); // daily: no clock
    expect(leakCategory(START, 19, 50, 150, 180)).toBe('opening'); // move 10
    expect(leakCategory(START, 20, 50, 150, 180)).toBe('middlegame'); // move 11
  });
});

describe('leakReport', () => {
  it('sustainedWinningNeedsTwoConsecutiveOwnMoves', () => {
    const games = [
      // alice (White) is at 80 before her 2nd move only, then drops: not clearly winning
      game({ id: 'once', sans: SANS, wins: winsFrom({ 1: 80, 3: 60 }) }),
      // at 80 before her 2nd and 3rd moves: clearly winning
      game({ id: 'twice', sans: SANS, wins: winsFrom({ 1: 80 }) }),
      // at 80 before her 2nd, 4th and 6th moves but never two in a row
      game({ id: 'gaps', sans: SANS, wins: winsFrom({ 1: 80, 3: 60, 5: 80, 7: 60, 9: 80, 11: 60 }) }),
    ];
    const r = leakReport(games, ['alice']);
    expect(r.conversion.winningGames).toBe(1);
  });

  it('lostShareOfLosses', () => {
    const winning = winsFrom({ 1: 80 }); // alice clearly winning
    const theyWin = winsFrom({ 0: 20 }); // bob (Black) clearly winning
    const games = [
      game({ id: 'w1', sans: SANS, wins: winning, outcome: 'win' }),
      game({ id: 'w2', sans: SANS, wins: winning, outcome: 'draw' }),
      game({ id: 'w3', sans: SANS, wins: winning, outcome: 'loss' }),
      game({ id: 'l1', sans: SANS, wins: theyWin, outcome: 'loss' }),
      game({ id: 'l2', sans: SANS, outcome: 'loss' }),
      game({ id: 'l3', sans: SANS, outcome: 'loss' }),
    ];
    const r = leakReport(games, ['alice']);
    expect(r.conversion).toMatchObject({ winningGames: 3, won: 1, drawn: 1, lost: 1, oppWinningGames: 1 });
    expect(r.conversion.convertedPct).toBeCloseTo(100 / 3, 10);
    expect(r.conversion.lostShareOfLossesPct).toBeCloseTo(25, 10); // 1 of 4 losses
    expect(r.conversion.oppConvertedPct).toBeCloseTo(100, 10);
    expect(r.avgScore).toBeCloseTo(1.5 / 6, 10);
    const [lo, hi] = r.conversion.lostShareRange;
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(lo).toBeLessThanOrEqual(25);
    expect(hi).toBeGreaterThanOrEqual(25);
    expect(hi).toBeLessThanOrEqual(100);
    expect(r.whatIf).toBeNull(); // 6 games: below the floors for an estimate
    expect(r.notes).toContain('Not enough games for an estimate yet.');
    // every loss came from a winning position: the range can only be 100%
    const allFromWinning = leakReport([games[2], games[2]].map((c, i) => ({ ...c, game: { ...c.game, id: `x${i}` } })), ['alice']);
    expect(allFromWinning.conversion.lostShareRange).toEqual([100, 100]);
  });

  it('whatIfNeedsEnoughGamesAndIsCappedAndLabelledRough', () => {
    const winning = winsFrom({ 1: 80 });
    const set = (spec: [Outcome, boolean, number][]) =>
      spec.flatMap(([outcome, isWinning, count], s) =>
        Array.from({ length: count }, (_, i) =>
          game({ id: `${s}-${i}`, sans: SANS, wins: isWinning ? winning : undefined, outcome }),
        ),
      );
    // 60 games: 30 clearly winning (24 won, 6 lost) and 30 level (15 won, 15 lost)
    const normal = leakReport(set([['win', true, 24], ['loss', true, 6], ['win', false, 15], ['loss', false, 15]]), ['alice']);
    expect(normal.whatIf?.label).toMatch(/rough/i);
    expect(normal.whatIf?.label).toBe('Rough estimate: if you lost half as many of the games you were winning');
    expect(normal.whatIf?.extraScorePerGame).toBeCloseTo(3 / 60, 10);
    expect(normal.whatIf?.ratingPoints).toBe(Math.round(eloForScoreGain(3 / 60, 39 / 60) / 5) * 5);
    expect(normal.whatIf!.ratingPoints % 5).toBe(0);
    // 40 games: 30 clearly winning (10 won, 20 lost) and 10 level losses → +0.25 a game, capped at 0.1 in the slope
    const big = leakReport(set([['win', true, 10], ['loss', true, 20], ['loss', false, 10]]), ['alice']);
    expect(big.whatIf?.extraScorePerGame).toBeCloseTo(0.25, 10);
    expect(big.whatIf?.ratingPoints).toBe(Math.round(eloForScoreGain(0.1, 0.25) / 5) * 5);
    // too few games, or too few winning games: no estimate
    for (const tiny of [set([['loss', true, 1]]), set([['loss', true, 2], ['win', true, 1], ['loss', false, 1]])]) {
      const r = leakReport(tiny, ['alice']);
      expect(r.conversion.lost).toBeGreaterThan(0);
      expect(r.whatIf).toBeNull();
      expect(r.notes).toContain('Not enough games for an estimate yet.');
    }
    const fewWinning = leakReport(set([['loss', true, LEAK_CFG.focusMinWinningGames - 1], ['win', false, 20]]), ['alice']);
    expect(fewWinning.games).toBeGreaterThanOrEqual(STATS_CFG.minGames);
    expect(fewWinning.whatIf).toBeNull();
  });

  it('rangesReliableOnlyFromTheGameFloor', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => game({ id: `g${i}`, sans: SANS, wins: winsFrom({ 20: 40 }) }));
    expect(leakReport(many(4), ['alice']).rangesReliable).toBe(false);
    expect(leakReport(many(STATS_CFG.minGames - 1), ['alice']).rangesReliable).toBe(false);
    expect(leakReport(many(STATS_CFG.minGames), ['alice']).rangesReliable).toBe(true);
    expect(leakReport([], ['alice']).rangesReliable).toBe(false);
  });

  it('readsTheMoversOwnPreviousClock', () => {
    // alice (White) gives away 10 points with her move at ply 22. Only clocks[20] (her clock after
    // her previous move) is low; the opponent's clock (ply 21) and her clock after the move are not.
    const clocks = SANS.map((_, i) => (i === 20 ? 10 : 170));
    const r = leakReport([game({ id: 'clk', sans: SANS, wins: winsFrom({ 22: 40 }), clocks })], ['alice']);
    const clock = r.leaks.find((l) => l.key === 'clock')!;
    expect(clock.givenAwayPer10).toBeCloseTo(1.0, 10);
    expect(clock.moves).toBe(1);
    expect(clock.sharePct).toBeCloseTo(100, 10);
  });

  it('sharesAreRatioOfSumsNotMeanOfShares', () => {
    // game 1 gives away 0.5 in the middlegame, game 2 gives away 0.1 in the first moves
    const a = game({ id: 'big', sans: SANS, wins: winsFrom({ 20: 0 }) });
    const b = game({ id: 'small', sans: SANS, wins: winsFrom({ 2: 40 }) });
    const r = leakReport([a, b], ['alice']);
    expect(r.leaks.find((l) => l.key === 'middlegame')!.sharePct).toBeCloseTo((100 * 0.5) / 0.6, 10); // not 50
    expect(r.leaks.find((l) => l.key === 'opening')!.sharePct).toBeCloseTo((100 * 0.1) / 0.6, 10);
  });

  it('convertsAndFindsCandidatesForBlack', () => {
    // alice plays Black. White's win % 20 → Black at 80 before her first two moves: clearly winning.
    // Her 2nd move (ply 3) drops her from 80 to 65: a keep-the-win position.
    const c = game({ id: 'black', sans: SANS, myColor: 'black', wins: winsFrom({ 0: 20, 3: 35 }), outcome: 'loss', endTime: 9 });
    const r = leakReport([c], ['alice']);
    expect(r.conversion).toMatchObject({ winningGames: 1, lost: 1, oppWinningGames: 0 });
    expect(keepTheWinCandidates([c], ['alice'])).toEqual([
      { gameId: 'black', ply: 3, outcome: 'loss', endTime: 9, quickLossPts: 15 },
    ]);
  });

  it('timeLossesFromTermination', () => {
    const games = [
      game({ id: 'a', sans: SANS, outcome: 'loss', termination: 'bob won on time' }),
      game({ id: 'b', sans: SANS, outcome: 'loss', termination: 'bob won by resignation' }),
      game({ id: 'c', sans: SANS, outcome: 'win', termination: 'alice won on time' }),
      game({ id: 'd', sans: SANS, outcome: 'draw', termination: 'Game drawn by timeout vs insufficient material' }),
      game({ id: 'e', sans: SANS, outcome: 'loss' }),
    ];
    expect(leakReport(games, ['alice']).timeLosses).toEqual({ losses: 3, onTime: 1, sharePct: 100 / 3 });
  });

  it('counts give-aways, big mistakes and moves per situation', () => {
    // alice loses 10 points with a middlegame move (ply 20); bob loses 20 with his reply
    const c = game({ id: 'g', sans: SANS, wins: winsFrom({ 20: 40, 21: 60 }) });
    const r = leakReport([c], ['alice']);
    const mg = r.leaks.find((l) => l.key === 'middlegame')!;
    expect(mg.givenAwayPer10).toBeCloseTo(1.0, 10); // 0.10 of a game, per 10 games
    expect(mg.oppGivenAwayPer10).toBeCloseTo(2.0, 10);
    expect(mg.bigMistakesPerGame).toBe(1);
    expect(mg.moves).toBe(10); // her moves 11–20
    expect(mg.sharePct).toBeCloseTo(100, 10);
    expect(mg.label).toBe('Balanced middlegames');
  });

  it('sharesSumTo100', () => {
    const rng = testRng(5);
    const games = Array.from({ length: 60 }, (_, g) => {
      const sans = randomSans(200 + g, 80);
      let w = 50;
      const wins = sans.map((_, i) => {
        const loss = rng() < 0.08 ? 8 + rng() * 20 : rng() * 3;
        return (w = Math.min(100, Math.max(0, i % 2 === 0 ? w - loss : w + loss)));
      });
      const clocks = sans.map((_, i) => Math.max(1, 180 - i * 2.5));
      return game({ id: `r${g}`, sans, wins, clocks, myColor: g % 2 ? 'black' : 'white', outcome: g % 3 ? 'loss' : 'win' });
    });
    const r = leakReport(games, ['alice']);
    expect(r.leaks.map((l) => l.key).sort()).toEqual([...LEAK_KEYS].sort());
    expect(r.leaks.reduce((s, l) => s + l.sharePct, 0)).toBeCloseTo(100, 8);
    for (let i = 1; i < r.leaks.length; i++) expect(r.leaks[i - 1].sharePct).toBeGreaterThanOrEqual(r.leaks[i].sharePct);
    for (const l of r.leaks) {
      expect(l.shareRange[0]).toBeLessThanOrEqual(l.sharePct + 1e-9);
      expect(l.shareRange[1]).toBeGreaterThanOrEqual(l.sharePct - 1e-9);
    }
    expect(leakReport(games, ['alice'])).toEqual(r); // seeded: same input, same report
  });

  it('filtersToUsernames', () => {
    const alice = [1, 2, 3].map((i) => game({ id: `a${i}`, sans: SANS, outcome: 'loss' }));
    const carol = [1, 2].map((i) => {
      const c = game({ id: `c${i}`, sans: SANS, wins: winsFrom({ 1: 80, 2: 65 }), outcome: 'loss', endTime: 100 * i });
      return { ...c, game: { ...c.game, username: 'carol' } };
    });
    const r = leakReport([...alice, ...carol], ['ALICE']);
    expect(r.games).toBe(3);
    expect(r.timeLosses.losses).toBe(3);
    expect(r.notes.join(' ')).toMatch(/2 games from other accounts were left out/);
    expect(leakReport([...alice, ...carol], ['alice', 'Carol']).games).toBe(5);
    expect(keepTheWinCandidates([...alice, ...carol], ['alice'])).toEqual([]);
    expect(keepTheWinCandidates([...alice, ...carol], ['carol']).map((k) => k.gameId)).toEqual(['c2', 'c1']);
  });

  it('noNaNOnEmpty', () => {
    const r = leakReport([], ['alice']);
    expect(r.games).toBe(0);
    expect(r.leaks).toHaveLength(6);
    expect(r.whatIf).toBeNull();
    expect(r.notes.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    const numbers: number[] = [];
    JSON.stringify(r, (_k, v) => (typeof v === 'number' && numbers.push(v), v));
    expect(numbers.every(Number.isFinite)).toBe(true);
  });
});

describe('chooseLeakFocus', () => {
  const conv = (winningGames: number, lostShareOfLossesPct: number): Conversion => ({
    winningGames, won: 0, drawn: 0, lost: 0, convertedPct: 0, lostShareOfLossesPct, lostShareRange: [0, 0],
    oppWinningGames: 0, oppConvertedPct: 0,
  });
  const time = (losses: number, sharePct: number): TimeLosses => ({ losses, onTime: 0, sharePct });
  const leak = (key: LeakKey, sharePct: number): Leak => ({
    key, label: key, sharePct, shareRange: [sharePct, sharePct], bigMistakesPerGame: 0, givenAwayPer10: 0,
    oppGivenAwayPer10: 0, moves: 0,
  });
  const leaks = [leak('losing', 40), leak('opening', 35), leak('middlegame', 25)];

  it('focusRuleOrder', () => {
    expect(chooseLeakFocus(conv(30, 20), time(100, 50), leaks)).toEqual({ kind: 'keepTheWin' });
    expect(chooseLeakFocus(conv(29, 50), time(30, 15), leaks)).toEqual({ kind: 'clock' });
    expect(chooseLeakFocus(conv(30, 19.9), time(30, 15), leaks)).toEqual({ kind: 'clock' });
    expect(chooseLeakFocus(conv(30, 19.9), time(29, 50), leaks)).toEqual({ kind: 'leak', key: 'opening' }); // never "already losing"
    expect(chooseLeakFocus(conv(0, 0), time(30, 14.9), leaks)).toEqual({ kind: 'leak', key: 'opening' });
  });

  it('focusNeverLeaksClockOrSneaksInWinning', () => {
    const clockTop = [leak('clock', 50), leak('middlegame', 30), leak('losing', 20)];
    expect(chooseLeakFocus(conv(0, 0), time(10, 0), clockTop)).toEqual({ kind: 'clock' }); // never { leak, clock }
    const winningTop = [leak('winning', 40), leak('opening', 30), leak('losing', 30)];
    // keep-the-win failed only for lack of winning games: skip "already winning", take the next
    expect(chooseLeakFocus(conv(29, 50), time(10, 0), winningTop)).toEqual({ kind: 'leak', key: 'opening' });
    // enough winning games but few lost: "already winning" may still be the focus
    expect(chooseLeakFocus(conv(30, 10), time(10, 0), winningTop)).toEqual({ kind: 'leak', key: 'winning' });
    // nothing given away at all (empty input): the documented placeholder
    const zeros = LEAK_KEYS.map((k) => leak(k, 0));
    expect(chooseLeakFocus(conv(0, 0), time(0, 0), zeros)).toEqual({ kind: 'leak', key: 'middlegame' });
    expect(leakReport([], ['alice']).focus).toEqual({ kind: 'leak', key: 'middlegame' });
  });
});

describe('eloForScoreGain', () => {
  it('eloForScoreGainMatchesLogisticSlope', () => {
    expect(eloForScoreGain(0.01, 0.5)).toBeCloseTo(6.95, 2); // 400/ln10 × 0.01 / 0.25
    expect(eloForScoreGain(0.01, 0.99)).toBeCloseTo(eloForScoreGain(0.01, 0.95), 12); // clamped
    expect(eloForScoreGain(0.01, 0)).toBeCloseTo(eloForScoreGain(0.01, 0.05), 12);
    expect(eloForScoreGain(0, 0.4)).toBe(0);
  });
});

describe('keepTheWinCandidates', () => {
  it('keepTheWinCandidatesOrder', () => {
    // alice at 80 before her 2nd move, then drops 15 points (a mistake)
    const slip = winsFrom({ 1: 80, 2: 65 });
    const games = [
      game({ id: 'lostOld', sans: SANS, wins: slip, outcome: 'loss', endTime: 100 }),
      game({ id: 'lostNew', sans: SANS, wins: slip, outcome: 'loss', endTime: 200 }),
      game({ id: 'drawn', sans: SANS, wins: slip, outcome: 'draw', endTime: 300 }),
      game({ id: 'won', sans: SANS, wins: slip, outcome: 'win', endTime: 400 }),
      // a mistake while level (before 50): not a keep-the-win position
      game({ id: 'level', sans: SANS, wins: winsFrom({ 2: 35 }), outcome: 'loss', endTime: 500 }),
      // bob blunders while he is winning: not alice's move
      game({ id: 'theirs', sans: SANS, wins: winsFrom({ 0: 20, 1: 40 }), outcome: 'win', endTime: 600 }),
    ];
    const k = keepTheWinCandidates(games, ['alice']);
    expect(k.map((x) => x.gameId)).toEqual(['lostNew', 'lostOld', 'drawn', 'won']);
    expect(k[0]).toEqual({ gameId: 'lostNew', ply: 2, outcome: 'loss', endTime: 200, quickLossPts: 15 });
  });
});
