import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearUsername,
  getAnalysis,
  getAnalysisSummaries,
  getAnalyzedIds,
  getUsername,
  saveAnalysis,
  setUsername,
} from './storage';
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
