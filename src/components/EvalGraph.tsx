import type { PlyAnalysis } from '../types';

interface Props {
  plies: PlyAnalysis[];
  /** 0 = start position, k = after ply k. */
  currentIndex: number;
  onSeek: (index: number) => void;
}

const WIDTH = 100;
const HEIGHT = 40;

/**
 * White-win-% across the game as a filled area chart. Tapping seeks to the
 * nearest ply. Hand-rolled SVG — no chart dependency.
 */
export function EvalGraph({ plies, currentIndex, onSeek }: Props) {
  if (plies.length === 0) return null;

  const n = plies.length;
  const x = (i: number) => (n === 1 ? WIDTH / 2 : (i / (n - 1)) * WIDTH);
  const y = (winPct: number) => HEIGHT - (winPct / 100) * HEIGHT;

  const points = plies.map((p, i) => `${x(i).toFixed(2)},${y(p.winPctWhite).toFixed(2)}`);
  const areaPath = `0,${HEIGHT} ${points.join(' ')} ${WIDTH},${HEIGHT}`;

  function handleClick(event: React.MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    const index = Math.round(ratio * n);
    onSeek(Math.max(0, Math.min(n, index)));
  }

  // currentIndex 0..n maps onto ply markers 0..n-1.
  const markerPly = Math.max(0, Math.min(n - 1, currentIndex - 1));

  return (
    <svg
      className="eval-graph"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      onClick={handleClick}
      role="img"
      aria-label="Evaluation over the game"
    >
      <rect x="0" y="0" width={WIDTH} height={HEIGHT} className="eval-bg" />
      <polygon className="eval-area" points={areaPath} />
      <polyline className="eval-line" data-testid="eval-line" points={points.join(' ')} />
      <line
        className="eval-marker"
        x1={x(markerPly)}
        y1="0"
        x2={x(markerPly)}
        y2={HEIGHT}
      />
    </svg>
  );
}
