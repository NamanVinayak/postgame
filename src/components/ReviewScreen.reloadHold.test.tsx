import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AnalysisResult, GameSummary } from '../types';

// A new app version must never reload the page in the middle of an analysis:
// ReviewScreen holds the reload from the start of analyzeGame until the result is saved.
const order: string[] = [];
let finishAnalysis: (r: AnalysisResult) => void = () => {};

vi.mock('../pwa/updates', () => ({
  holdReload: vi.fn(() => {
    order.push('hold');
    return vi.fn(() => order.push('release'));
  }),
}));
vi.mock('../analysis/analyzeGame', () => ({
  analyzeGame: vi.fn(
    () =>
      new Promise<AnalysisResult>((resolve) => {
        finishAnalysis = resolve;
      }),
  ),
}));
vi.mock('../services/storage', () => ({
  getAnalysis: vi.fn(async () => null),
  saveAnalysis: vi.fn(async () => {
    order.push('save');
  }),
}));
vi.mock('../services/engine/stockfishEngine', () => ({
  createStockfishEngine: vi.fn(() => ({ evaluate: vi.fn(), terminate: vi.fn() })),
}));
vi.mock('./Board', () => ({ Board: () => <div /> }));

import { holdReload } from '../pwa/updates';
import { ReviewScreen } from './ReviewScreen';

const game: GameSummary = {
  id: 'game-1',
  url: 'https://example.invalid/game/1',
  timeClass: 'blitz',
  endTime: 1780000000,
  rated: true,
  myColor: 'white',
  outcome: 'win',
  opponent: { username: 'opponent', rating: 1500 },
  myRating: 1500,
  pgn: '[Event "x"]\n\n1. e4 e5 *',
};

const noMoves = { great: 0, best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
const result: AnalysisResult = {
  gameId: 'game-1',
  schemaVersion: 7,
  plies: [],
  whiteAccuracy: 90,
  blackAccuracy: 90,
  counts: { white: noMoves, black: noMoves },
  missedWins: { white: 0, black: 0 },
  misses: { white: 0, black: 0 },
  createdAt: 0,
};

describe('ReviewScreen and app updates', () => {
  beforeEach(() => {
    order.length = 0;
    vi.mocked(holdReload).mockClear();
  });

  test('holdsTheReloadUntilTheAnalysisIsSaved', async () => {
    render(<ReviewScreen game={game} myUsername="me" onBack={vi.fn()} />);
    await waitFor(() => expect(holdReload).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['hold']);

    finishAnalysis(result);
    await waitFor(() => expect(order).toContain('release'));
    expect(order).toEqual(['hold', 'save', 'release']);
  });

  test('releasesTheHoldWhenTheUserLeavesMidAnalysis', async () => {
    const { unmount } = render(<ReviewScreen game={game} myUsername="me" onBack={vi.fn()} />);
    await waitFor(() => expect(holdReload).toHaveBeenCalledTimes(1));

    unmount();
    expect(order).toEqual(['hold', 'release']);
  });
});
