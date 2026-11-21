import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AnalysisResult } from '../types';
import { SCHEMA_VERSION } from '../constants';
import type { CoachPack } from '../training/pack';
import type { DrillProgress } from '../training/scheduler';
import { localDay } from '../training/day';

const USERNAME_KEY = 'postgame.username';
const TRAINING_DAYS_KEY = 'postgame.trainingDays';
const TRAINING_DAYS_KEPT = 30;
const PACK_KEY = 'current';

interface PostgameDB extends DBSchema {
  analyses: {
    key: string;
    value: AnalysisResult;
  };
  coachPack: {
    key: string;
    value: CoachPack;
  };
  drillProgress: {
    key: string;
    value: DrillProgress;
  };
}

let dbPromise: Promise<IDBPDatabase<PostgameDB>> | null = null;

function db(): Promise<IDBPDatabase<PostgameDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PostgameDB>('postgame', 2, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) database.createObjectStore('analyses', { keyPath: 'gameId' });
        if (oldVersion < 2) {
          database.createObjectStore('coachPack');
          database.createObjectStore('drillProgress', { keyPath: 'drillId' });
        }
      },
    });
  }
  return dbPromise;
}

export async function getCachedPack(): Promise<CoachPack | null> {
  return (await (await db()).get('coachPack', PACK_KEY)) ?? null;
}

export async function saveCachedPack(pack: CoachPack): Promise<void> {
  await (await db()).put('coachPack', pack, PACK_KEY);
}

export async function clearCachedPack(): Promise<void> {
  await (await db()).delete('coachPack', PACK_KEY);
}

export async function getAllProgress(): Promise<Map<string, DrillProgress>> {
  const all = await (await db()).getAll('drillProgress');
  return new Map(all.map((p) => [p.drillId, p]));
}

export async function saveProgress(p: DrillProgress): Promise<void> {
  await (await db()).put('drillProgress', p);
}

/** Days (YYYY-MM-DD, local time) on which at least one drill was answered; oldest first, last 30 kept. */
export function getTrainingDays(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TRAINING_DAYS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

export function markTrainedToday(now: number): void {
  const today = localDay(now);
  const days = getTrainingDays();
  if (days.includes(today)) return;
  localStorage.setItem(TRAINING_DAYS_KEY, JSON.stringify([...days, today].slice(-TRAINING_DAYS_KEPT)));
}

export function getUsername(): string | null {
  return localStorage.getItem(USERNAME_KEY);
}

export function setUsername(name: string): void {
  localStorage.setItem(USERNAME_KEY, name);
}

export function clearUsername(): void {
  localStorage.removeItem(USERNAME_KEY);
}

/** Returns the cached analysis, or null if missing or from an older schema. */
export async function getAnalysis(gameId: string): Promise<AnalysisResult | null> {
  const result = await (await db()).get('analyses', gameId);
  if (!result || result.schemaVersion !== SCHEMA_VERSION) return null;
  return result;
}

export async function saveAnalysis(result: AnalysisResult): Promise<void> {
  await (await db()).put('analyses', result);
}

/** Of the given ids, which have a fresh (current-schema) cached analysis. */
export async function getAnalyzedIds(ids: string[]): Promise<Set<string>> {
  const database = await db();
  const found = new Set<string>();
  await Promise.all(
    ids.map(async (id) => {
      const r = await database.get('analyses', id);
      if (r && r.schemaVersion === SCHEMA_VERSION) found.add(id);
    }),
  );
  return found;
}

export interface AnalysisSummary {
  whiteAccuracy: number;
  blackAccuracy: number;
}

/** Accuracy summaries for the given ids that have a fresh cached analysis. */
export async function getAnalysisSummaries(
  ids: string[],
): Promise<Map<string, AnalysisSummary>> {
  const database = await db();
  const map = new Map<string, AnalysisSummary>();
  await Promise.all(
    ids.map(async (id) => {
      const r = await database.get('analyses', id);
      if (r && r.schemaVersion === SCHEMA_VERSION) {
        map.set(id, { whiteAccuracy: r.whiteAccuracy, blackAccuracy: r.blackAccuracy });
      }
    }),
  );
  return map;
}
