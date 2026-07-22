import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { GameSummary } from '../types';

vi.mock('../services/chesscom', () => ({ fetchRecentGames: vi.fn() }));
vi.mock('../services/storage', () => ({ getAnalysisSummaries: vi.fn() }));

import { fetchRecentGames } from '../services/chesscom';
import { getAnalysisSummaries } from '../services/storage';
import { useRecentGames } from './useRecentGames';

const mockFetch = fetchRecentGames as unknown as ReturnType<typeof vi.fn>;
const mockSummaries = getAnalysisSummaries as unknown as ReturnType<typeof vi.fn>;

function game(id: string, endTime: number): GameSummary {
  return {
    id,
    url: id,
    timeClass: 'blitz',
    endTime,
    rated: true,
    myColor: 'white',
    outcome: 'win',
    opponent: { username: 'opp', rating: 1000 },
    myRating: 1000,
    pgn: '',
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSummaries.mockReset();
  mockSummaries.mockResolvedValue(new Map());
});

describe('useRecentGames', () => {
  test('initial load populates games without a "new games" message', async () => {
    mockFetch.mockResolvedValueOnce([game('g2', 200), game('g1', 100)]);
    const { result } = renderHook(() => useRecentGames('user'));
    await waitFor(() => expect(result.current.games).toHaveLength(2));
    expect(result.current.statusMessage).toBe('');
  });

  test('a later refresh reports newly found games and prepends them', async () => {
    mockFetch.mockResolvedValueOnce([game('g2', 200), game('g1', 100)]);
    const { result } = renderHook(() => useRecentGames('user'));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.games).toHaveLength(2);

    mockFetch.mockResolvedValueOnce([game('g3', 300), game('g2', 200), game('g1', 100)]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.games).toHaveLength(3);
    expect(result.current.games[0].id).toBe('g3');
    expect(result.current.statusMessage).toBe('1 new game found');
  });

  test('surfaces analyzed-game accuracy for the connected color', async () => {
    mockFetch.mockResolvedValueOnce([game('g1', 100)]);
    mockSummaries.mockResolvedValueOnce(
      new Map([['g1', { whiteAccuracy: 73.4, blackAccuracy: 60 }]]),
    );
    const { result } = renderHook(() => useRecentGames('user'));
    await waitFor(() => expect(result.current.accuracyById.get('g1')).toBe(73.4));
  });
});
