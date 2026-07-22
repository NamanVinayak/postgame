import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AnalysisResult } from '../types';
import { SCHEMA_VERSION } from '../constants';

const USERNAME_KEY = 'postgame.username';

interface PostgameDB extends DBSchema {
  analyses: {
    key: string;
    value: AnalysisResult;
  };
}

let dbPromise: Promise<IDBPDatabase<PostgameDB>> | null = null;

function db(): Promise<IDBPDatabase<PostgameDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PostgameDB>('postgame', 1, {
      upgrade(database) {
        database.createObjectStore('analyses', { keyPath: 'gameId' });
      },
    });
  }
  return dbPromise;
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
