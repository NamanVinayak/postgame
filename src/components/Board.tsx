import { Chessboard } from 'react-chessboard';
import type { Color } from '../types';

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
          darkSquareStyle: { backgroundColor: '#6f7d5a' },
          lightSquareStyle: { backgroundColor: '#e9e6d6' },
        }}
      />
    </div>
  );
}
