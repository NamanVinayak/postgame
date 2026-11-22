/**
 * The report radar's scale: each spoke shows you RELATIVE to players at your rating.
 *
 * Players at your rating are a perfect regular hexagon at PEER_RADIUS (a fraction of the
 * chart's radius) on every spoke. Your point sits outside it when you made fewer serious
 * mistakes than them in that area and inside when you made more.
 *
 * The mapping, and why:
 * - It compares serious-mistake rates as a ratio, on a log scale: radius = PEER_RADIUS +
 *   (1 − PEER_RADIUS) × log2(their rate ÷ your rate), clamped to ±1. Half their rate reaches
 *   the rim; double their rate reaches the inner limit (MIN_RADIUS).
 * - A ratio, not a difference, because the areas have very different baselines (about 4% of
 *   moves when behind, about 20% in middlegames). A ratio makes the same relative gap look the
 *   same in every area.
 * - A log scale so the mapping is symmetric: "half as many" is as far out as "twice as many"
 *   is in. It is monotone: more of your own mistakes never moves your point outwards.
 * - Mistake rates rather than mistake-free moves (100 − rate): for mistake-free moves the
 *   ratio stays within a few percent of 1 even for a real weak spot (e.g. 89% vs 92%), so a
 *   gap that matters would be invisible. The mistake-rate ratio shows it (11% vs 8% is about
 *   0.46 of the way to "double"), and it points the same way, since fewer mistakes = outside.
 * - The likely-range band on each spoke uses this same mapping. The axis labels keep the
 *   absolute numbers ("9.6% vs 9.0%").
 *
 * Equal rates land exactly on the hexagon, so when every area is within about half a point
 * of the players at your rating, the shape sits on the hexagon. That is the honest picture.
 */
import type { ReportLabel, ReportRow } from '../../src/server/views';

export const PEER_RADIUS = 0.6;
/** How many doublings of the mistake rate separate the hexagon from the rim (and from the inner limit). */
export const SPAN_DOUBLINGS = 1;
/** The innermost a point can be drawn: double their rate or worse. */
export const MIN_RADIUS = PEER_RADIUS - (1 - PEER_RADIUS);

/**
 * log2(their rate ÷ your rate), not clamped: + = fewer serious mistakes than them. No mistakes
 * at all against some of theirs is +Infinity; the reverse is −Infinity; equal rates are 0.
 */
export function doublings(you: number, them: number): number {
  const y = Math.max(0, you);
  const t = Math.max(0, them);
  if (y === t) return 0;
  if (y === 0) return Number.POSITIVE_INFINITY;
  if (t === 0) return Number.NEGATIVE_INFINITY;
  return Math.log2(t / y);
}

/** Where your point sits on a spoke, as a fraction of the chart's radius (MIN_RADIUS … 1). */
export function relativeRadius(you: number, them: number): number {
  const d = Math.max(-SPAN_DOUBLINGS, Math.min(SPAN_DOUBLINGS, doublings(you, them)));
  return PEER_RADIUS + (1 - PEER_RADIUS) * (d / SPAN_DOUBLINGS);
}

/** A likely-range band's two ends on a spoke, and whether the chart's edge cuts either one. */
export interface BandEnds {
  /** From your highest likely rate (fractions of the chart's radius). */
  inner: number;
  /** From your lowest likely rate. */
  outer: number;
  /** The band would run below the inner limit (more than double their rate). */
  cutInner: boolean;
  /** The band would run past the rim (under half their rate). */
  cutOuter: boolean;
}

/**
 * Where "where you likely are" runs on a spoke: your likely range of mistake rates on the same
 * scale as your point. Every band is drawn the same way. Where the chart's edge cuts one, the
 * widget marks the cut with a small end tick rather than hiding it.
 */
export function bandEnds(range: [number, number], them: number): BandEnds {
  const [lo, hi] = range;
  return {
    inner: relativeRadius(hi, them),
    outer: relativeRadius(lo, them),
    cutInner: doublings(hi, them) < -SPAN_DOUBLINGS,
    cutOuter: doublings(lo, them) > SPAN_DOUBLINGS,
  };
}

/** With more areas than this short of games, no shape is drawn at all: only the points we have. */
export const MAX_UNKNOWN_FOR_SHAPE = 2;

/** Whether the chart draws your filled shape: at least three areas with numbers, at most two without. */
export function shapeDrawn(rows: Pick<ReportRow, 'you' | 'them'>[]): boolean {
  const known = rows.filter((r) => r.you !== null && r.them !== null).length;
  return known >= 3 && rows.length - known <= MAX_UNKNOWN_FOR_SHAPE;
}

/** How each verdict reads on a chip. "Too close to call" and "Not enough games" stay neutral. */
export const VERDICTS: Record<ReportLabel, { icon: string; text: string; tone: 'good' | 'bad' | 'neutral' | 'faint' }> = {
  gap: { icon: '✗', text: 'Weak spot', tone: 'bad' },
  notYourProblem: { icon: '✓', text: 'Not a weak spot', tone: 'good' },
  noClearDifference: { icon: '–', text: 'Too close to call', tone: 'neutral' },
  notEnoughData: { icon: '?', text: 'Not enough games', tone: 'faint' },
};

export const pct = (x: number) => `${x.toFixed(1)}%`;

/**
 * The chart in plain words, for screen readers: which areas sit outside the hexagon (fewer
 * serious mistakes than players at your rating), which inside (more), which level, which have
 * too few games, then each area's numbers and verdict. Empty groups are left out. It speaks of
 * "your shape" only when the chart draws one (see shapeDrawn), otherwise of "your points".
 */
export function radarSummary(rows: Pick<ReportRow, 'area' | 'label' | 'you' | 'them'>[]): string {
  const outside: string[] = [];
  const inside: string[] = [];
  const level: string[] = [];
  const unknown: string[] = [];
  for (const r of rows) {
    if (r.you === null || r.them === null) unknown.push(r.area);
    else if (r.you < r.them) outside.push(r.area);
    else if (r.you > r.them) inside.push(r.area);
    else level.push(r.area);
  }
  const parts = [`Your ${shapeDrawn(rows) ? 'shape' : 'points'} against players at your rating, the dashed hexagon.`];
  if (outside.length) parts.push(`Outside it, fewer serious mistakes than them: ${outside.join(', ')}.`);
  if (inside.length) parts.push(`Inside it, more: ${inside.join(', ')}.`);
  if (level.length) parts.push(`Level with them: ${level.join(', ')}.`);
  if (unknown.length) parts.push(`Not enough games: ${unknown.join(', ')}.`);
  const each = rows.map((r) => {
    const verdict = VERDICTS[r.label].text.toLowerCase();
    return r.you !== null && r.them !== null ? `${r.area}: you ${pct(r.you)}, them ${pct(r.them)}, ${verdict}` : `${r.area}: ${verdict}`;
  });
  parts.push(`The chips give the verdict. ${each.join('; ')}.`);
  return parts.join(' ');
}
