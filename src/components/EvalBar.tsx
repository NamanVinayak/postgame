import type { Color } from '../types';

interface Props {
  /** White's win probability for the current position, 0..100. */
  winPctWhite: number;
  /** Board orientation — the color at the bottom of the board. */
  orientation: Color;
}

/**
 * Vertical evaluation bar beside the board. The white portion grows toward the
 * side that is winning; it sits at the bottom when the board faces White and at
 * the top when it faces Black, so it always lines up with the board.
 */
export function EvalBar({ winPctWhite, orientation }: Props) {
  const whitePct = Math.max(0, Math.min(100, winPctWhite));
  const whiteAtBottom = orientation === 'white';

  return (
    <div
      className="eval-bar"
      role="img"
      aria-label={`White win chance ${whitePct.toFixed(0)}%`}
    >
      <div
        className="eval-bar-white"
        style={{ height: `${whitePct}%`, [whiteAtBottom ? 'bottom' : 'top']: 0 }}
      />
    </div>
  );
}
