import { Chessboard } from 'react-chessboard';
import type { Color } from '../types';
import { BOARD_SQUARE_COLORS } from '../constants';

interface Props {
  fen: string;
  orientation: Color;
}

/** Read-only board showing a single position. */
export function Board({ fen, orientation }: Props) {
  return (
    <div className="board-wrap">
      <Chessboard
        options={{
          id: 'review-board',
          position: fen,
          boardOrientation: orientation,
          allowDragging: false,
          showNotation: true,
          animationDurationInMs: 150,
          darkSquareStyle: { backgroundColor: BOARD_SQUARE_COLORS.dark },
          lightSquareStyle: { backgroundColor: BOARD_SQUARE_COLORS.light },
        }}
      />
    </div>
  );
}
