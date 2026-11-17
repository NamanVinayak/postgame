import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MoveList } from './MoveList';
import { MISS_META, MISSED_WIN_META } from './classificationMeta';
import type { PlyAnalysis } from '../types';

function ply(partial: Partial<PlyAnalysis>): PlyAnalysis {
  return {
    ply: 0,
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

describe('MoveList', () => {
  test('a missed win overrides the classification dot color', () => {
    const plies = [
      ply({ ply: 0, moveSan: 'e4', classification: 'blunder', isMissedWin: true }),
      ply({ ply: 1, moveSan: 'e5', color: 'black', classification: 'mistake', isMiss: true }),
      ply({ ply: 2, moveSan: 'Nf3', classification: 'blunder' }),
    ];
    render(<MoveList plies={plies} currentIndex={0} onSelect={vi.fn()} />);
    expect(screen.getByTestId('move-dot-0')).toHaveStyle({
      backgroundColor: MISSED_WIN_META.color,
    });
    expect(screen.getByTestId('move-dot-1')).toHaveStyle({
      backgroundColor: MISS_META.color,
    });
    // A plain blunder keeps the blunder color.
    expect(screen.getByTestId('move-dot-2')).toHaveStyle({ backgroundColor: '#d0574e' });
  });

  test('cells announce their label for screen readers', () => {
    const plies = [ply({ ply: 0, moveSan: 'e4', classification: 'blunder', isMissedWin: true })];
    render(<MoveList plies={plies} currentIndex={0} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'e4 — Missed win' })).toBeInTheDocument();
  });
});
