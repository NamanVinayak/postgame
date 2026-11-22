import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../../../src/constants';
import type { AnalysisResult } from '../../../src/types';
import { ENGINE_CFG, coachHome, ensureDirs } from '../config';
import type { CoachGame } from '../sources/types';

export interface CachedGame {
  game: CoachGame;
  analysis: AnalysisResult;
}

/** Hash of game id + schema version + engine time, so changing either one invalidates old entries. */
export function cacheKey(gameId: string): string {
  return createHash('sha256').update(`${gameId}${SCHEMA_VERSION}${ENGINE_CFG.movetimeMs}`).digest('hex');
}

function fileFor(gameId: string): string {
  return join(coachHome(), 'cache', `${cacheKey(gameId)}.json`);
}

/** The cached analysis of a game, or null if missing, unreadable or for a different game. */
export function readCached(gameId: string): CachedGame | null {
  try {
    const parsed = JSON.parse(readFileSync(fileFor(gameId), 'utf8')) as CachedGame;
    if (parsed?.game?.id !== gameId || !parsed.analysis) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Writes one JSON file per game. Temp file + rename, so a killed process never leaves half-written JSON. */
export function writeCached(c: CachedGame): void {
  ensureDirs();
  const file = fileFor(c.game.id);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
