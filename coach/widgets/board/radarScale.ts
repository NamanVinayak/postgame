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

/** Where your point sits on a spoke, as a fraction of the chart's radius (MIN_RADIUS … 1). */
export function relativeRadius(you: number, them: number): number {
  const y = Math.max(0, you);
  const t = Math.max(0, them);
  let doublings: number; // + = fewer serious mistakes than them
  if (y === t) doublings = 0;
  else if (y === 0) doublings = SPAN_DOUBLINGS;
  else if (t === 0) doublings = -SPAN_DOUBLINGS;
  else doublings = Math.max(-SPAN_DOUBLINGS, Math.min(SPAN_DOUBLINGS, Math.log2(t / y)));
  return PEER_RADIUS + (1 - PEER_RADIUS) * (doublings / SPAN_DOUBLINGS);
}

/** The quietest a likely-range band is drawn. */
export const MIN_BAND_OPACITY = 0.35;

/**
 * How strongly to draw a spoke's likely-range band, from where its outer end sits (a fraction
 * of the chart's radius). Up to the hexagon it is drawn at full strength. Beyond it, it fades
 * the further it pokes out, reaching MIN_BAND_OPACITY halfway to the rim. A wide band then
 * never reads louder than your point.
 */
export function bandOpacity(outer: number): number {
  const beyond = Math.max(0, outer - PEER_RADIUS) / (1 - PEER_RADIUS); // 0 at the hexagon, 1 at the rim
  const k = beyond / 0.5;
  if (k >= 1) return MIN_BAND_OPACITY;
  return 1 - (1 - MIN_BAND_OPACITY) * k;
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
 * too few games, then each area's numbers and verdict. Empty groups are left out.
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
  const parts = ['Your shape against players at your rating, the dashed hexagon.'];
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
