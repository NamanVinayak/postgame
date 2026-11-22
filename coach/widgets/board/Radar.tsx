import type { ReportLabel, ReportRow } from '../../src/server/views';

/** How each verdict reads on a chip. "Too close to call" and "Not enough games" stay neutral. */
export const VERDICTS: Record<ReportLabel, { icon: string; text: string; tone: 'good' | 'bad' | 'neutral' | 'faint' }> = {
  gap: { icon: '✗', text: 'Weak spot', tone: 'bad' },
  notYourProblem: { icon: '✓', text: 'Not a weak spot', tone: 'good' },
  noClearDifference: { icon: '–', text: 'Too close to call', tone: 'neutral' },
  notEnoughData: { icon: '?', text: 'Not enough games', tone: 'faint' },
};

export function Chip({ label }: { label: ReportLabel }) {
  const v = VERDICTS[label];
  return (
    <span className={`rc-chip rc-chip--${v.tone}`}>
      <span className="rc-chipIcon" aria-hidden="true">
        {v.icon}
      </span>
      {v.text}
    </span>
  );
}

/** The six areas always go round the chart in the same order, whatever order the rows come in. */
const AREA_ORDER = ['Openings', 'Middlegames', 'Endgames', "When you're ahead", "When you're behind", 'Low on the clock'];
const orderOf = (area: string) => {
  const i = AREA_ORDER.indexOf(area);
  return i === -1 ? AREA_ORDER.length : i;
};

export const pct = (x: number) => `${x.toFixed(1)}%`;

/**
 * The chart's scale.
 *
 * Each spoke plots the share of moves WITHOUT a serious mistake (100 − mistake rate), so a
 * bigger shape means fewer serious mistakes. Every spoke uses the same straight-line scale,
 * from `floor` at the centre to 100% at the rim. `floor` is the round ten at least 5 points
 * below the lowest value drawn (yours, theirs or the likely range), so the smallest value
 * still sits clear of the centre.
 *
 * Why not start at 0%: real values sit between about 80% and 96%, so from 0 every point would
 * hug the rim and no difference would show. Why it stays honest: the scale is one shared
 * straight line, so one percentage point is the same length on every spoke, "you" and
 * "players at your rating" are drawn on the same scale, and nothing is stretched per area.
 * The card states where the centre is ("the centre is 70%").
 */
export function radarFloor(rows: ReportRow[]): number {
  const values = rows.flatMap((r) => [r.you, r.them, r.range?.[1]]).filter((v): v is number => v != null);
  if (values.length === 0) return 0;
  const lowest = 100 - Math.max(...values);
  return Math.min(90, Math.max(0, Math.floor((lowest - 5) / 10) * 10));
}

interface Geometry {
  w: number;
  h: number;
  r: number;
}
const SIZES: Record<'compact' | 'large', Geometry> = {
  compact: { w: 560, h: 380, r: 108 },
  large: { w: 560, h: 520, r: 160 },
};

/**
 * The hexagon: you (filled) against players at your rating (dashed outline), with where you
 * likely are drawn as a soft band along each spoke. An area with too few games gets a faint
 * spoke and no point; the shape joins the areas that have numbers.
 */
export function Radar({ rows, size }: { rows: ReportRow[]; size: 'compact' | 'large' }) {
  const sorted = rows.map((row, i) => ({ row, i })).sort((a, b) => orderOf(a.row.area) - orderOf(b.row.area) || a.i - b.i);
  const n = sorted.length;
  const { w, h, r: R } = SIZES[size];
  const floor = radarFloor(rows);
  /** Radius for a mistake rate: plots 100 − rate on the shared scale above. */
  const rad = (rate: number) => Math.max(0, Math.min(R, (R * (100 - rate - floor)) / (100 - floor)));

  const axes = sorted.map(({ row }, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { row, cos: Math.cos(ang), sin: Math.sin(ang), known: row.you !== null && row.them !== null };
  });
  const at = (r: number, a: (typeof axes)[number]) => [r * a.cos, r * a.sin] as const;
  const pts = (list: (readonly [number, number])[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const known = axes.filter((a) => a.known);
  const you = known.map((a) => at(rad(a.row.you!), a));
  const them = known.map((a) => at(rad(a.row.them!), a));
  const ringStep = 100 - floor <= 40 ? 10 : 20;
  const rings: number[] = [];
  for (let v = floor + ringStep; v < 100; v += ringStep) rings.push(v);
  rings.push(100); // the rim

  // Top and bottom labels sit closer to the chart than the side ones, keeping the block compact.
  const labelAt = (a: (typeof axes)[number]) => {
    const off = Math.abs(a.cos) < 0.3 ? 44 : 70;
    return { left: `${(((R + off) * a.cos + w / 2) / w) * 100}%`, top: `${(((R + off) * a.sin + h / 2) / h) * 100}%` };
  };

  const summary = known.map((a) => `${a.row.area}: you ${pct(a.row.you!)}, players at your rating ${pct(a.row.them!)}`).join('; ');

  return (
    <div className={`rc-radar rc-radar--${size}`} style={{ aspectRatio: `${w} / ${h}` }}>
      <svg
        viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`}
        role="img"
        aria-label={`Share of moves that were serious mistakes. ${summary}`}
      >
        <defs>
          <radialGradient id="rc-you-fill" cx="0" cy="0" r={R} gradientUnits="userSpaceOnUse">
            <stop offset="0" className="rc-stop0" />
            <stop offset="1" className="rc-stop1" />
          </radialGradient>
          <filter id="rc-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        {rings.map((v) => {
          const rr = (R * (v - floor)) / (100 - floor);
          return <polygon key={v} points={pts(axes.map((a) => at(rr, a)))} className="rc-grid" />;
        })}
        {axes.map((a, i) => (
          <line key={i} x1="0" y1="0" x2={R * a.cos} y2={R * a.sin} className={a.known ? 'rc-spoke' : 'rc-spoke rc-spoke--faint'} />
        ))}
        {axes.map((a, i) => {
          if (!a.known || !a.row.range) return null;
          const [x1, y1] = at(rad(a.row.range[1]), a);
          const [x2, y2] = at(rad(a.row.range[0]), a);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="rc-range" />;
        })}
        {known.length >= 3 && (
          <>
            <polygon points={pts(them)} className="rc-peer" />
            <polygon points={pts(you)} className="rc-youGlow" filter="url(#rc-glow)" />
            <polygon points={pts(you)} className="rc-you" fill="url(#rc-you-fill)" />
          </>
        )}
        {known.length < 3 &&
          them.map(([x, y], i) => <circle key={`t${i}`} cx={x} cy={y} r="5" className="rc-peerDot" />)}
        {you.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="4.5" className="rc-youDot" />
        ))}
      </svg>
      {axes.map((a, i) => (
        <div key={i} className={`rc-axis${a.known ? '' : ' rc-axis--faint'}`} style={labelAt(a)}>
          <div className="rc-axisName">{a.row.area}</div>
          <div className="rc-axisNums">
            {a.known ? (
              <>
                <b>{pct(a.row.you!)}</b> <span>vs {pct(a.row.them!)}</span>
              </>
            ) : (
              <span>
                {a.row.games} game{a.row.games === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <Chip label={a.row.label} />
        </div>
      ))}
    </div>
  );
}
