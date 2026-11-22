import { describe, expect, it } from 'vitest';
import { STATS_CFG } from '../config';
import { bootstrapGap, mulberry32, type GameCounts } from './stats';
import { scatter, testRng } from './testGames';

/** `games` games of 30 moves per side; `myErr` / `oppErr` errors scattered over all moves of each side. */
function perGame(games: number, myErr: number, oppErr: number, seed: number): GameCounts[] {
  const rng = testRng(seed);
  const mine = scatter(myErr, games * 30, rng);
  const theirs = scatter(oppErr, games * 30, rng);
  return Array.from({ length: games }, (_, g) => ({
    myErr: mine.slice(g * 30, g * 30 + 30).filter(Boolean).length,
    myN: 30,
    oppErr: theirs.slice(g * 30, g * 30 + 30).filter(Boolean).length,
    oppN: 30,
  }));
}

describe('bootstrapGap', () => {
  it('bootstrapDeterministicAndCentered', () => {
    const rows = perGame(40, 120, 60, 7); // I err on 10% of 1200 moves, the opponent on 5%
    const a = bootstrapGap(rows, STATS_CFG.bootstrapN, STATS_CFG.seed);
    const b = bootstrapGap(rows, STATS_CFG.bootstrapN, STATS_CFG.seed);
    expect(a).toEqual(b);
    expect(a.gap).toBeCloseTo(5, 10);
    expect(a.ci95[0]).toBeGreaterThan(0);
    expect(a.ci95[0]).toBeLessThan(a.gap);
    expect(a.ci95[1]).toBeGreaterThan(a.gap);
    expect(Math.abs((a.ci95[0] + a.ci95[1]) / 2 - a.gap)).toBeLessThan(0.5);
    // the adjusted range is the wider one
    expect(a.ciAdj[0]).toBeLessThan(a.ci95[0]);
    expect(a.ciAdj[1]).toBeGreaterThan(a.ci95[1]);
    // another seed moves the range a little, never the point estimate
    const c = bootstrapGap(rows, STATS_CFG.bootstrapN, STATS_CFG.seed + 1);
    expect(c.gap).toBe(a.gap);
    expect(c.ci95).not.toEqual(a.ci95);
  });

  it('uses the ratio of sums, so long games weigh more than short ones', () => {
    const rows: GameCounts[] = [
      { myErr: 1, myN: 10, oppErr: 0, oppN: 10 },
      { myErr: 0, myN: 90, oppErr: 0, oppN: 90 },
    ];
    expect(bootstrapGap(rows, 200, 1).gap).toBeCloseTo(1, 10); // 1 of 100 moves, not the mean of 10% and 0%
  });

  it('stays finite when a side has no moves at all', () => {
    const r = bootstrapGap([{ myErr: 0, myN: 0, oppErr: 1, oppN: 10 }], 100, 1);
    expect([r.gap, ...r.ci95, ...r.ciAdj].every(Number.isFinite)).toBe(true);
    const empty = bootstrapGap([], 100, 1);
    expect([empty.gap, ...empty.ci95, ...empty.ciAdj].every(Number.isFinite)).toBe(true);
  });

  it('mulberry32 is seeded and stays in [0, 1)', () => {
    const r1 = mulberry32(1804);
    const r2 = mulberry32(1804);
    const xs = Array.from({ length: 1000 }, () => r1());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => r2()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(Math.abs(xs.reduce((s, x) => s + x, 0) / 1000 - 0.5)).toBeLessThan(0.05);
  });
});
