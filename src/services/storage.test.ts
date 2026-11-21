import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearCachedPack,
  clearUsername,
  getAllProgress,
  getAnalysis,
  getAnalysisSummaries,
  getAnalyzedIds,
  getCachedPack,
  getTrainingDays,
  getUsername,
  markTrainedToday,
  saveAnalysis,
  saveCachedPack,
  saveProgress,
  setUsername,
} from './storage';
import type { CoachPack } from '../training/pack';

describe('training storage', () => {
  const pack: CoachPack = { schema: 1, generated: '2026-11-21', openings: [], drills: [] };

  test('coach pack round-trip and clear', async () => {
    await saveCachedPack(pack);
    expect(await getCachedPack()).toEqual(pack);
    await clearCachedPack();
    expect(await getCachedPack()).toBeNull();
  });

  test('progress round-trip, keyed by drill id', async () => {
    await saveProgress({ drillId: 'a', box: 1, dueAt: 10, lapses: 0, reviews: 1, lastPositionIndex: 0 });
    await saveProgress({ drillId: 'a', box: 2, dueAt: 20, lapses: 0, reviews: 2, lastPositionIndex: 0 });
    const all = await getAllProgress();
    expect(all.size).toBe(1);
    expect(all.get('a')?.box).toBe(2);
  });

  test('training days: one entry per day, newest kept, at most 30', () => {
    localStorage.clear();
    const day = 86_400_000;
    const start = new Date(2026, 9, 1, 12).getTime();
    markTrainedToday(start);
    markTrainedToday(start + 1000);
    expect(getTrainingDays()).toHaveLength(1);
    for (let i = 1; i <= 40; i++) markTrainedToday(start + i * day);
    const days = getTrainingDays();
    expect(days).toHaveLength(30);
    expect(days[days.length - 1]).toBe('2026-11-10');
  });
});
import type { AnalysisResult } from '../types';
import { SCHEMA_VERSION } from '../constants';

function makeResult(gameId: string, schemaVersion = SCHEMA_VERSION): AnalysisResult {
  return {
    gameId,
    schemaVersion,
    plies: [],
    whiteAccuracy: 90,
    blackAccuracy: 80,
    counts: {
      white: { great: 0, best: 1, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 },
      black: { great: 0, best: 0, good: 1, inaccuracy: 0, mistake: 0, blunder: 0 },
    },
    missedWins: { white: 0, black: 0 },
    misses: { white: 0, black: 0 },
    createdAt: 123,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('username storage', () => {
  test('set / get / clear round-trip', () => {
    expect(getUsername()).toBeNull();
    setUsername('MyUser');
    expect(getUsername()).toBe('MyUser');
    clearUsername();
    expect(getUsername()).toBeNull();
  });
});

describe('analysis cache', () => {
  test('save then get returns the stored result', async () => {
    await saveAnalysis(makeResult('g1'));
    const got = await getAnalysis('g1');
    expect(got?.gameId).toBe('g1');
    expect(got?.whiteAccuracy).toBe(90);
  });

  test('getAnalysis returns null for a stale schema version', async () => {
    await saveAnalysis(makeResult('g2', SCHEMA_VERSION - 1));
    expect(await getAnalysis('g2')).toBeNull();
  });

  test('getAnalyzedIds returns only fresh cached ids', async () => {
    await saveAnalysis(makeResult('a'));
    await saveAnalysis(makeResult('b', SCHEMA_VERSION - 1));
    const ids = await getAnalyzedIds(['a', 'b', 'c']);
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(false);
    expect(ids.has('c')).toBe(false);
  });

  test('getAnalysisSummaries returns accuracies for fresh cached ids only', async () => {
    await saveAnalysis(makeResult('s1'));
    await saveAnalysis(makeResult('s2', SCHEMA_VERSION - 1));
    const map = await getAnalysisSummaries(['s1', 's2', 's3']);
    expect(map.get('s1')).toEqual({ whiteAccuracy: 90, blackAccuracy: 80 });
    expect(map.has('s2')).toBe(false);
    expect(map.has('s3')).toBe(false);
  });
});
