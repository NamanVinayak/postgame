import { STATS_CFG } from '../config';

/** One game's serious mistakes and moves in one area: the player's and the comparison side's. */
export interface GameCounts {
  myErr: number;
  myN: number;
  oppErr: number;
  oppN: number;
}

/** Small seeded random generator (mulberry32): same seed, same sequence, values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile of an ascending array (q in [0, 1]). */
function quantile(sorted: Float64Array, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** (my errors ÷ my moves − their errors ÷ their moves) × 100, or null when a side has no moves. */
function gapOf(myErr: number, myN: number, oppErr: number, oppN: number): number | null {
  return myN > 0 && oppN > 0 ? (myErr / myN - oppErr / oppN) * 100 : null;
}

/**
 * The gap in serious-mistake rate (percentage points, player minus comparison) over these
 * games, pooled as a ratio of sums, with ranges from resampling whole games with
 * replacement `n` times (seeded). `ci95` is the 95% range; `ciAdj` is the wider two-sided
 * 1 − STATS_CFG.gapAlpha range, from the same resamples, used before calling anything a gap.
 * Resamples where a side ends up with no moves are skipped. When there is nothing to
 * compare, everything is 0.
 */
export function bootstrapGap(
  perGame: GameCounts[],
  n: number,
  seed: number,
): { gap: number; ci95: [number, number]; ciAdj: [number, number] } {
  const g = perGame.length;
  const me = new Float64Array(g);
  const meN = new Float64Array(g);
  const op = new Float64Array(g);
  const opN = new Float64Array(g);
  let sMe = 0, sMeN = 0, sOp = 0, sOpN = 0;
  perGame.forEach((r, i) => {
    me[i] = r.myErr; meN[i] = r.myN; op[i] = r.oppErr; opN[i] = r.oppN;
    sMe += r.myErr; sMeN += r.myN; sOp += r.oppErr; sOpN += r.oppN;
  });
  const gap = gapOf(sMe, sMeN, sOp, sOpN);
  if (gap === null) return { gap: 0, ci95: [0, 0], ciAdj: [0, 0] };

  const rand = mulberry32(seed);
  const draws = new Float64Array(n);
  let k = 0;
  for (let b = 0; b < n; b++) {
    let a = 0, an = 0, o = 0, on = 0;
    for (let j = 0; j < g; j++) {
      const i = (rand() * g) | 0;
      a += me[i]; an += meN[i]; o += op[i]; on += opN[i];
    }
    const d = gapOf(a, an, o, on);
    if (d !== null) draws[k++] = d;
  }
  if (k === 0) return { gap, ci95: [gap, gap], ciAdj: [gap, gap] };
  const sorted = draws.subarray(0, k).sort();
  const half = STATS_CFG.gapAlpha / 2;
  return {
    gap,
    ci95: [quantile(sorted, 0.025), quantile(sorted, 0.975)],
    ciAdj: [quantile(sorted, half), quantile(sorted, 1 - half)],
  };
}
