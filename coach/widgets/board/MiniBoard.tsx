import type { CSSProperties } from 'react';
import { Chessboard, defaultArrowOptions } from 'react-chessboard';
import type { Arrow } from './shared';

// Small boards need thicker arrows to read.
const MINI_ARROWS = { ...defaultArrowOptions, arrowWidthDenominator: 4 };

export const toMoveText = (fen: string) => (fen.split(' ')[1] === 'w' ? 'White to move' : 'Black to move');

/**
 * A small, still board in the paper look (the report card's lesson boards and quick fixes, and
 * the examples panel's rows). Arrows and square tints come from the caller only.
 */
export function MiniBoard({
  id,
  fen,
  orientation,
  arrows = [],
  squareStyles = {},
  label,
}: {
  id: string;
  fen: string;
  orientation: 'white' | 'black';
  arrows?: Arrow[];
  squareStyles?: Record<string, CSSProperties>;
  label: string;
}) {
  return (
    <div className="rc-mini" role="img" aria-label={label}>
      <Chessboard
        options={{
          id,
          position: fen,
          boardOrientation: orientation,
          arrows,
          arrowOptions: MINI_ARROWS,
          squareStyles,
          allowDragging: false,
          allowDrawingArrows: false,
          showNotation: false,
          showAnimations: false,
          darkSquareStyle: { backgroundColor: 'var(--rc-sq-dark)' },
          lightSquareStyle: { backgroundColor: 'var(--rc-sq-light)' },
        }}
      />
    </div>
  );
}
