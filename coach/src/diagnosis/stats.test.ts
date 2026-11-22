import { describe, expect, it } from 'vitest';
import { STATS_CFG } from '../config';
import { binomialUpperTail, bootstrapGap, mulberry32, type GameCounts } from './stats';
import { spreadRows } from './testGames';

const width = (r: { ci95: [number, number] }) => r.ci95[1] - r.ci95[0];

describe('bootstrapGap', () => {
  it('bootstrapDeterministicAndCentered', () => {
    const rows = spreadRows(40, 30, 120, 60, 7); // I err on 10% of 1200 moves, the opponent on 5%
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

  it('bunchedMistakesWidenRange', () => {
    // Same totals (120 vs 60 over 40 games of 30 moves a side); only how they fall across games differs.
    const even: GameCounts[] = Array.from({ length: 40 }, (_, g) => ({ myErr: 3, myN: 30, oppErr: g % 2 ? 1 : 2, oppN: 30 }));
    const bunched: GameCounts[] = even.map((r, g) => ({ ...r, myErr: g < 12 ? 10 : 0 }));
    const e = bootstrapGap(even, STATS_CFG.bootstrapN, STATS_CFG.seed);
    const b = bootstrapGap(bunched, STATS_CFG.bootstrapN, STATS_CFG.seed);
    expect(b.gap).toBeCloseTo(e.gap, 10);
    expect(width(b)).toBeGreaterThan(2 * width(e));
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

describe('binomialUpperTail', () => {
  it('binomialTailIsExactAndNeverOverflows', () => {
    // P(X ≥ 18) for X ~ Bin(24, 1/2) = 190051 / 2^24
    expect(binomialUpperTail(18, 24, 0.5)).toBeCloseTo(190051 / 2 ** 24, 12);
    expect(binomialUpperTail(7, 7, 0.5)).toBeCloseTo(1 / 128, 12);
    expect(binomialUpperTail(0, 10, 0.3)).toBe(1);
    expect(binomialUpperTail(11, 10, 0.3)).toBe(0);
    // large counts stay finite and sensible
    const mid = binomialUpperTail(3000, 6000, 0.5);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(0.52);
    const far = binomialUpperTail(5000, 6000, 0.5);
    expect(Number.isFinite(far)).toBe(true);
    expect(far).toBeGreaterThanOrEqual(0);
    expect(far).toBeLessThan(1e-100);
  });
});
