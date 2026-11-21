import { useRef, useState, type CSSProperties } from 'react';
import { Chessboard } from 'react-chessboard';
import { BOARD_SQUARE_COLORS } from '../../constants';
import { dropPiece, tapSquare } from '../../training/moveCheck';

const DRAG_START_PX = 10;
const WOBBLE_CLICK_MS = 400;

export interface BoardArrow {
  from: string;
  to: string;
  color: 'green' | 'red';
}

interface Props {
  fen: string;
  orientation: 'white' | 'black';
  interactive: boolean;
  /** Return true to accept the move (the board then shows the new position you pass in). */
  onMove?: (from: string, to: string) => boolean;
  arrows?: BoardArrow[];
  highlight?: string[];
  /** Slide pieces between positions (off when lines replay instantly). */
  animate?: boolean;
}

const ARROW_COLOR = { green: 'rgba(127, 166, 80, 0.9)', red: 'rgba(208, 87, 78, 0.9)' };
const HIGHLIGHT: CSSProperties = { backgroundColor: 'rgba(240, 200, 80, 0.45)' };
const SELECTED: CSSProperties = { boxShadow: 'inset 0 0 0 4px rgba(127, 166, 80, 0.95)' };

/** Board for drills: tap a piece then a square, or drag. Arrows and highlights are shown on request. */
export function TrainBoard({
  fen,
  orientation,
  interactive,
  onMove,
  arrows = [],
  highlight = [],
  animate = true,
}: Props) {
  // Selection belongs to one position; a new position clears it.
  const [pick, setPick] = useState<{ fen: string; square: string } | null>(null);
  const lastWobble = useRef<{ square: string; at: number } | null>(null);
  const selected = pick && pick.fen === fen ? pick.square : null;
  const turn = fen.split(' ')[1];

  const squareStyles: Record<string, CSSProperties> = {};
  for (const sq of highlight) squareStyles[sq] = HIGHLIGHT;
  if (selected) squareStyles[selected] = { ...squareStyles[selected], ...SELECTED };

  return (
    <div className="board-wrap" data-testid="train-board">
      <Chessboard
        options={{
          id: 'train-board',
          position: fen,
          boardOrientation: orientation,
          allowDragging: interactive,
          allowDrawingArrows: false,
          showNotation: true,
          showAnimations: animate,
          animationDurationInMs: 200,
          darkSquareStyle: { backgroundColor: BOARD_SQUARE_COLORS.dark },
          lightSquareStyle: { backgroundColor: BOARD_SQUARE_COLORS.light },
          squareStyles,
          arrows: arrows.map((a) => ({ startSquare: a.from, endSquare: a.to, color: ARROW_COLOR[a.color] })),
          canDragPiece: ({ piece }) => interactive && piece.pieceType[0] === turn,
          // A finger always wobbles a little; only a real drag should count as one.
          dragActivationDistance: DRAG_START_PX,
          onPieceDrop: ({ sourceSquare, targetSquare }) => {
            if (!interactive || !onMove) return false;
            const next = dropPiece(selected, sourceSquare, targetSquare, fen);
            setPick(next.selected ? { fen, square: next.selected } : null);
            if (!next.move) {
              lastWobble.current = { square: sourceSquare, at: Date.now() };
              return false;
            }
            return onMove(next.move.from, next.move.to);
          },
          onSquareClick: ({ square }) => {
            if (!interactive || !onMove) return;
            // The click some browsers send after a wobble-drop must not undo the selection it just made.
            const w = lastWobble.current;
            if (w && w.square === square && Date.now() - w.at < WOBBLE_CLICK_MS) return;
            const next = tapSquare(selected, square, fen);
            setPick(next.selected ? { fen, square: next.selected } : null);
            if (next.move) onMove(next.move.from, next.move.to);
          },
        }}
      />
    </div>
  );
}
