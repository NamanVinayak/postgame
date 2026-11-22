import type { CSSProperties } from 'react';
import { Chessboard } from 'react-chessboard';

export const PLAYED_ARROW = 'rgba(207, 34, 46, 0.85)';
export const BEST_ARROW = 'rgba(26, 127, 55, 0.85)';
const SQUARES = { dark: '#6f7d5a', light: '#e9e6d6' }; // same as the Postgame web app
export const LAST_MOVE = { backgroundColor: 'rgba(255, 214, 10, 0.42)' };
export const SELECTED = { backgroundColor: 'rgba(255, 214, 10, 0.6)' };
export const TARGET = { background: 'radial-gradient(circle, rgba(20, 20, 20, 0.28) 22%, transparent 24%)' };
export const TARGET_CAPTURE = { background: 'radial-gradient(circle, transparent 58%, rgba(20, 20, 20, 0.28) 60%)' };

export type Arrow = { startSquare: string; endSquare: string; color: string };

/** A react-chessboard arrow for a UCI move such as "g8f6" or "e7e8q". */
export function arrowFor(uci: string | null, color: string): Arrow | null {
  if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  return { startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color };
}

/** Text of every text block in a tool result. */
export function resultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface BoardProps {
  fen: string;
  orientation: 'white' | 'black';
  arrows?: Arrow[];
  squareStyles?: Record<string, CSSProperties>;
  interactive?: {
    canDrag: (pieceType: string) => boolean;
    onDrop: (from: string, to: string) => boolean;
    onSquareClick: (square: string) => void;
  };
}

/** The board every view uses: Postgame's colours, coordinates on, arrows only from the view. */
export function Board({ fen, orientation, arrows = [], squareStyles = {}, interactive }: BoardProps) {
  return (
    <div className="pg-board">
      <Chessboard
        options={{
          id: 'postgame-coach-board',
          position: fen,
          boardOrientation: orientation,
          arrows,
          squareStyles,
          allowDragging: interactive !== undefined,
          allowDrawingArrows: false,
          showNotation: true,
          darkSquareStyle: { backgroundColor: SQUARES.dark },
          lightSquareStyle: { backgroundColor: SQUARES.light },
          canDragPiece: interactive ? ({ piece }) => interactive.canDrag(piece.pieceType) : undefined,
          onPieceDrop: interactive
            ? ({ sourceSquare, targetSquare }) => (targetSquare ? interactive.onDrop(sourceSquare, targetSquare) : false)
            : undefined,
          onSquareClick: interactive ? ({ square }) => interactive.onSquareClick(square) : undefined,
        }}
      />
    </div>
  );
}
