import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Chess } from 'chess.js';
import { ReviewScreen } from './ReviewScreen';
import type { AnalysisResult, GameSummary, PlyAnalysis } from '../types';

vi.mock('../services/storage', () => ({
  getAnalysis: vi.fn(),
  saveAnalysis: vi.fn(),
}));

vi.mock('../services/engine/stockfishEngine', () => ({
  createStockfishEngine: vi.fn(() => ({ evaluate: vi.fn(), terminate: vi.fn() })),
}));

// The board itself is react-chessboard's job; the explorer test only needs the
// FEN the screen hands it.
vi.mock('./Board', () => ({
  Board: ({ fen }: { fen: string }) => <div data-testid="board" data-fen={fen} />,
}));

import { getAnalysis } from '../services/storage';

const mockedGetAnalysis = vi.mocked(getAnalysis);

const PGN = '[Event "x"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *';

const game: GameSummary = {
  id: 'game-1',
  url: 'https://www.chess.com/game/live/1',
  timeClass: 'blitz',
  endTime: 1780000000,
  rated: true,
  myColor: 'white',
  outcome: 'win',
  opponent: { username: 'opponent', rating: 1500 },
  myRating: 1500,
  pgn: PGN,
};

function ply(partial: Partial<PlyAnalysis> & { ply: number }): PlyAnalysis {
  return {
    moveSan: 'e4',
    color: 'white',
    evalCp: 20,
    mate: null,
    winPctWhite: 52,
    classification: 'best',
    isMissedWin: false,
    isMiss: false,
    bestMoveSan: null,
    bestLineSan: null,
    bestLineUci: null,
    reason: null,
    accuracy: 100,
    ...partial,
  };
}

// 3...Nc6 was a blunder; the best line from that position is 3...Nf6 4. d4.
const analysis: AnalysisResult = {
  gameId: 'game-1',
  schemaVersion: 6,
  plies: [
    ply({ ply: 0, moveSan: 'e4' }),
    ply({ ply: 1, moveSan: 'e5', color: 'black' }),
    ply({ ply: 2, moveSan: 'Nf3' }),
    ply({
      ply: 3,
      moveSan: 'Nc6',
      color: 'black',
      classification: 'blunder',
      bestMoveSan: 'Nf6',
      bestLineSan: ['Nf6', 'd4'],
      bestLineUci: ['g8f6', 'd2d4'],
      reason: 'A stronger move was Nf6.',
      accuracy: 40,
    }),
    ply({ ply: 4, moveSan: 'Bb5' }),
    ply({ ply: 5, moveSan: 'a6', color: 'black' }),
  ],
  whiteAccuracy: 90,
  blackAccuracy: 70,
  counts: {
    white: { great: 0, best: 3, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 },
    black: { great: 0, best: 2, good: 0, inaccuracy: 0, mistake: 0, blunder: 1 },
  },
  missedWins: { white: 0, black: 0 },
  misses: { white: 0, black: 0 },
  createdAt: 0,
};

/** FEN after playing `moves` (SAN) from the start position. */
function fenAfter(moves: string[]): string {
  const board = new Chess();
  for (const m of moves) board.move(m);
  return board.fen();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAnalysis.mockResolvedValue(analysis);
});

describe('ReviewScreen line explorer', () => {
  test('one tap shows the best move on the board, steps through the line, and returns', async () => {
    render(<ReviewScreen game={game} myUsername="me" onBack={() => {}} />);

    // Open the blunder's detail panel.
    fireEvent.click(await screen.findByRole('button', { name: 'Nc6 — Blunder' }));
    expect(await screen.findByText('Better: Nf6')).toBeInTheDocument();
    expect(screen.getByText('Best line')).toBeInTheDocument();

    // One tap: the best move is on the board.
    fireEvent.click(screen.getByRole('button', { name: 'Explore line' }));
    expect(screen.getByRole('status')).toHaveTextContent('Best line instead of Nc6');
    expect(screen.getByTestId('board')).toHaveAttribute(
      'data-fen',
      fenAfter(['e4', 'e5', 'Nf3', 'Nf6']),
    );

    // Step forward along the line: 3. d4.
    fireEvent.click(screen.getByRole('button', { name: 'Next line move' }));
    expect(screen.getByTestId('board')).toHaveAttribute(
      'data-fen',
      fenAfter(['e4', 'e5', 'Nf3', 'Nf6', 'd4']),
    );

    // Tapping a line chip jumps straight to that step.
    fireEvent.click(screen.getByRole('button', { name: '2... Nf6' }));
    expect(screen.getByTestId('board')).toHaveAttribute(
      'data-fen',
      fenAfter(['e4', 'e5', 'Nf3', 'Nf6']),
    );

    // Back to the game: the board shows the actual position after Nc6 again.
    // (Two "Back to game" buttons exist while exploring — banner and panel —
    // either returns to the game.)
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to game' })[0]);
    expect(screen.getByTestId('board')).toHaveAttribute(
      'data-fen',
      fenAfter(['e4', 'e5', 'Nf3', 'Nc6']),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('seeking to another move exits exploration', async () => {
    render(<ReviewScreen game={game} myUsername="me" onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nc6 — Blunder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Explore line' }));
    expect(screen.getByRole('status')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next move' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
