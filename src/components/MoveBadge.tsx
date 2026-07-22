import type { Color } from '../types';

interface Props {
  /** Destination square of the move, e.g. "e4". */
  square: string;
  /** Board orientation (whose side is at the bottom). */
  orientation: Color;
  glyph: string;
  color: string;
}

/**
 * A classification glyph pinned to the top-right corner of a move's destination
 * square, overlaid on the board. Positioned in percentages so it scales with
 * the board size.
 */
export function MoveBadge({ square, orientation, glyph, color }: Props) {
  const file = square.charCodeAt(0) - 97; // a=0 .. h=7
  const rank = parseInt(square[1], 10); // 1..8
  if (Number.isNaN(file) || Number.isNaN(rank)) return null;

  const col = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 8 - rank : rank - 1;

  return (
    <span
      className="move-badge"
      style={{
        left: `${(col + 1) * 12.5}%`,
        top: `${row * 12.5}%`,
        backgroundColor: color,
      }}
    >
      {glyph}
    </span>
  );
}
