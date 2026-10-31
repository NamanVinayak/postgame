import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { AccuracySummary } from './AccuracySummary';
import type { AnalysisResult } from '../types';

const analysis: AnalysisResult = {
  gameId: 'g1',
  schemaVersion: 1,
  plies: [],
  whiteAccuracy: 90.2,
  blackAccuracy: 71.6,
  counts: {
    white: { great: 0, best: 10, good: 5, inaccuracy: 1, mistake: 0, blunder: 0 },
    black: { great: 0, best: 4, good: 6, inaccuracy: 2, mistake: 1, blunder: 3 },
  },
  createdAt: 0,
};

describe('AccuracySummary', () => {
  test('shows the connected player as You with their accuracy and counts', () => {
    render(<AccuracySummary analysis={analysis} myColor="black" />);
    // "You" is black here.
    expect(screen.getByText('71.6%')).toBeInTheDocument();
    expect(screen.getByText('90.2%')).toBeInTheDocument();
    // Black had 3 blunders (shown on the "you" side).
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Blunders')).toBeInTheDocument();
  });
});
