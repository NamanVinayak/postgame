import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { GameRow } from './GameRow';
import type { GameSummary } from '../types';

const game: GameSummary = {
  id: 'g1',
  url: 'g1',
  timeClass: 'blitz',
  endTime: 1_784_600_000,
  rated: true,
  myColor: 'white',
  outcome: 'win',
  opponent: { username: 'rivalA', rating: 990 },
  myRating: 1005,
  pgn: '',
};

describe('GameRow', () => {
  test('unanalyzed game shows opponent, outcome, time class, and Analyze', () => {
    render(<GameRow game={game} onSelect={vi.fn()} />);
    expect(screen.getByText('rivalA')).toBeInTheDocument();
    expect(screen.getByText('Win')).toBeInTheDocument();
    expect(screen.getByLabelText('blitz')).toBeInTheDocument();
    expect(screen.getByText('Analyze')).toBeInTheDocument();
  });

  test('analyzed game shows accuracy and no Analyze CTA', () => {
    render(<GameRow game={game} accuracy={73.4} onSelect={vi.fn()} />);
    expect(screen.getByText(/73%/)).toBeInTheDocument();
    expect(screen.queryByText('Analyze')).not.toBeInTheDocument();
  });
});
