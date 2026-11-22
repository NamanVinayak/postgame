import type { ReportLabel, ReportRow } from '../../src/server/views';
import { MIN_RADIUS, PEER_RADIUS, VERDICTS, bandOpacity, pct, radarSummary, relativeRadius } from './radarScale';

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

/** With this many areas short of games, no shape is drawn at all: only the points we have. */
export const MAX_UNKNOWN_FOR_SHAPE = 2;

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
 * The hexagon, relative to players at your rating. They are the dashed regular hexagon. Your
 * filled shape goes outside it where you made fewer serious mistakes than them and inside where
 * you made more (the scale and its reasons are in radarScale.ts). Where you likely are is a soft
 * band along each spoke on the same scale, quieter the further it pokes outside the hexagon.
 *
 * An area with too few games has no point. Your outline passes through the hexagon there, since
 * there is no evidence either way: skipping the spoke would cut a chord deep inside the hexagon,
 * which on this scale reads as "more mistakes". The two segments that touch that spoke are dotted
 * and grey, the wedges either side are faded, and a hollow "?" ring marks the spot. With three or
 * more such areas no shape is drawn, only the points we have.
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
  type Axis = (typeof axes)[number];
  const at = (r: number, a: Axis) => [r * a.cos, r * a.sin] as const;
  const xy = ([x, y]: readonly [number, number]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const pts = (list: (readonly [number, number])[]) => list.map(xy).join(' ');

  const known = axes.filter((a) => a.known);
  const unknownCount = n - known.length;
  // Your outline's corner on each spoke: on the hexagon where the area has too few games.
  const corner = axes.map((a) => at(a.known ? rad(a.row.you!, a.row.them!) : R * PEER_RADIUS, a));
  const peer = axes.map((a) => at(R * PEER_RADIUS, a)); // the same on every spoke
  // Faint rings for structure only: the inner limit, halfway to the hexagon, halfway to the rim, the rim.
  const rings = [MIN_RADIUS, (MIN_RADIUS + PEER_RADIUS) / 2, (PEER_RADIUS + 1) / 2, 1];

  const showShape = known.length >= 3 && unknownCount <= MAX_UNKNOWN_FOR_SHAPE;
  const next = (i: number) => (i + 1) % n;
  const solidSide = (i: number) => axes[i].known && axes[next(i)].known;
  const wedge = (i: number) => `M0,0 L${xy(corner[i])} L${xy(corner[next(i)])} Z`;
  const sides = axes.map((_, i) => i);
  // One path per kind, so neighbouring wedges are filled as one shape with no seams between them.
  const solidFill = sides.filter(solidSide).map(wedge).join(' ');
  const fadedFill = sides.filter((i) => !solidSide(i)).map(wedge).join(' ');
  // The solid outline: runs of neighbouring known corners (one closed polygon when all are known).
  const runs: number[][] = [];
  if (unknownCount > 0) {
    const start = axes.findIndex((a) => !a.known);
    let run: number[] = [];
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (axes[i].known) run.push(i);
      else {
        if (run.length >= 2) runs.push(run);
        run = [];
      }
    }
  }
  const solidOutline = runs.map((run) => `M${run.map((i) => xy(corner[i])).join(' L')}`).join(' ');

  // Top and bottom labels sit closer to the chart than the side ones, keeping the block compact.
  const labelAt = (a: Axis) => {
    const off = Math.abs(a.cos) < 0.3 ? 44 : 70;
    return { left: `${(((R + off) * a.cos + w / 2) / w) * 100}%`, top: `${(((R + off) * a.sin + h / 2) / h) * 100}%` };
  };

  return (
    <div className={`rc-radar rc-radar--${size}`} style={{ aspectRatio: `${w} / ${h}` }}>
      <svg viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`} role="img" aria-label={radarSummary(sorted.map((s) => s.row))}>
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
          const outer = rad(a.row.range[0], a.row.them!); // your lowest likely rate sits furthest out
          const [x1, y1] = at(rad(a.row.range[1], a.row.them!), a);
          const [x2, y2] = at(outer, a);
          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="rc-range" style={{ opacity: bandOpacity(outer / R) }} />
          );
        })}
        {showShape && unknownCount === 0 && (
          <>
            <polygon points={pts(corner)} className="rc-youGlow" filter="url(#rc-glow)" />
            <polygon points={pts(corner)} className="rc-you" fill="url(#rc-you-fill)" />
          </>
        )}
        {showShape && unknownCount > 0 && (
          <>
            <path d={fadedFill} className="rc-youFade" fill="url(#rc-you-fill)" />
            <path d={solidFill} className="rc-youFill" fill="url(#rc-you-fill)" />
            {solidOutline && <path d={solidOutline} className="rc-youGlow" filter="url(#rc-glow)" />}
            {solidOutline && <path d={solidOutline} className="rc-you" fill="none" />}
            {sides
              .filter((i) => !solidSide(i))
              .map((i) => {
                const [x1, y1] = corner[i];
                const [x2, y2] = corner[next(i)];
                return <line key={`u${i}`} x1={x1} y1={y1} x2={x2} y2={y2} className="rc-youUnknown" />;
              })}
          </>
        )}
        {/* The dashed hexagon goes on top: where you match them it would otherwise hide under your line. */}
        <polygon points={pts(peer)} className="rc-peer" />
        {axes.map((a, i) =>
          a.known ? (
            <circle key={i} cx={corner[i][0]} cy={corner[i][1]} r="4.5" className="rc-youDot" />
          ) : (
            <g key={i} className="rc-unknownMark" transform={`translate(${xy(peer[i])})`}>
              <circle r="7.5" className="rc-unknownRing" />
              <text className="rc-unknownQ">?</text>
            </g>
          ),
        )}
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
