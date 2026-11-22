import type { ReportLabel, ReportRow } from '../../src/server/views';
import { MIN_RADIUS, PEER_RADIUS, relativeRadius } from './radarScale';

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
 * The hexagon, relative to players at your rating: they are the dashed regular hexagon, and
 * your filled shape goes outside it where you made fewer serious mistakes than them and inside
 * where you made more (the scale and its reasons are in radarScale.ts). Where you likely are is
 * a soft band along each spoke, on the same scale. An area with too few games gets a faint
 * spoke and no point, and your outline passes through the hexagon there: no evidence either
 * way. Skipping that spoke instead would cut a chord deep inside the hexagon, which on this
 * scale reads as "more mistakes" in an area we know nothing about.
 */
export function Radar({ rows, size }: { rows: ReportRow[]; size: 'compact' | 'large' }) {
  const sorted = rows.map((row, i) => ({ row, i })).sort((a, b) => orderOf(a.row.area) - orderOf(b.row.area) || a.i - b.i);
  const n = sorted.length;
  const { w, h, r: R } = SIZES[size];
  /** Radius on a spoke for your mistake rate against theirs (see radarScale.ts). */
  const rad = (you: number, them: number) => R * relativeRadius(you, them);

  const axes = sorted.map(({ row }, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { row, cos: Math.cos(ang), sin: Math.sin(ang), known: row.you !== null && row.them !== null };
  });
  const at = (r: number, a: (typeof axes)[number]) => [r * a.cos, r * a.sin] as const;
  const pts = (list: (readonly [number, number])[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const known = axes.filter((a) => a.known);
  const yourPoint = (a: (typeof axes)[number]) => at(a.known ? rad(a.row.you!, a.row.them!) : R * PEER_RADIUS, a);
  const outline = axes.map(yourPoint); // through the hexagon on spokes with too few games
  const you = known.map(yourPoint); // dots only where there are numbers
  const peer = axes.map((a) => at(R * PEER_RADIUS, a)); // the same on every spoke
  // Faint rings for structure only: the inner limit, halfway to the hexagon, halfway to the rim, the rim.
  const rings = [MIN_RADIUS, (MIN_RADIUS + PEER_RADIUS) / 2, (PEER_RADIUS + 1) / 2, 1];

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
        aria-label={`Serious mistakes compared with players at your rating. ${summary}`}
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
        {rings.map((f) => (
          <polygon key={f} points={pts(axes.map((a) => at(R * f, a)))} className="rc-grid" />
        ))}
        {axes.map((a, i) => (
          <line key={i} x1="0" y1="0" x2={R * a.cos} y2={R * a.sin} className={a.known ? 'rc-spoke' : 'rc-spoke rc-spoke--faint'} />
        ))}
        {axes.map((a, i) => {
          if (!a.known || !a.row.range) return null;
          const [x1, y1] = at(rad(a.row.range[1], a.row.them!), a);
          const [x2, y2] = at(rad(a.row.range[0], a.row.them!), a);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="rc-range" />;
        })}
        {known.length >= 3 && (
          <>
            <polygon points={pts(outline)} className="rc-youGlow" filter="url(#rc-glow)" />
            <polygon points={pts(outline)} className="rc-you" fill="url(#rc-you-fill)" />
          </>
        )}
        {/* The dashed hexagon goes on top: where you match them it would otherwise hide under your line. */}
        <polygon points={pts(peer)} className="rc-peer" />
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
