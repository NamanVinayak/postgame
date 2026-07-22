import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameSummary } from '../types';
import { fetchRecentGames } from '../services/chesscom';
import { getAnalysisSummaries } from '../services/storage';
import { COPY } from '../constants';

export type LoadStatus = 'idle' | 'loading' | 'error';

export interface RecentGames {
  games: GameSummary[];
  /** Connected user's accuracy per analyzed game id (absent = not analyzed). */
  accuracyById: Map<string, number>;
  status: LoadStatus;
  statusMessage: string;
  refresh: () => Promise<void>;
}

function pluralGames(n: number): string {
  return `${n} new game${n === 1 ? '' : 's'} found`;
}

export function useRecentGames(username: string): RecentGames {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [accuracyById, setAccuracyById] = useState<Map<string, number>>(new Map());
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');

  const firstLoad = useRef(true);
  const inFlight = useRef(false);
  const knownIds = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus('loading');
    try {
      const fetched = await fetchRecentGames(username);
      const newCount = fetched.filter((g) => !knownIds.current.has(g.id)).length;
      knownIds.current = new Set(fetched.map((g) => g.id));
      setGames(fetched);

      const summaries = await getAnalysisSummaries(fetched.map((g) => g.id));
      const accuracies = new Map<string, number>();
      for (const g of fetched) {
        const s = summaries.get(g.id);
        if (s) accuracies.set(g.id, g.myColor === 'white' ? s.whiteAccuracy : s.blackAccuracy);
      }
      setAccuracyById(accuracies);

      setStatusMessage(firstLoad.current ? '' : newCount > 0 ? pluralGames(newCount) : COPY.upToDate);
      firstLoad.current = false;
      setStatus('idle');
    } catch {
      setStatus('error');
      setStatusMessage('Could not load games.');
    } finally {
      inFlight.current = false;
    }
  }, [username]);

  useEffect(() => {
    // Reset when the connected account changes.
    firstLoad.current = true;
    knownIds.current = new Set();
    setGames([]);
    setAccuracyById(new Map());
    setStatusMessage('');
    refresh();

    let lastAt = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastAt < 2000) return; // debounce rapid toggles
      lastAt = Date.now();
      refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [username, refresh]);

  return { games, accuracyById, status, statusMessage, refresh };
}
