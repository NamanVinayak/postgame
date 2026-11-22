import { execFileSync } from 'node:child_process';

/** Pulls "System-wide memory free percentage: 63%" out of `memory_pressure` output; null if absent. */
export function parseFreeMemoryPct(output: string): number | null {
  const m = /System-wide memory free percentage:\s*(\d+)\s*%/i.exec(output);
  return m ? Number(m[1]) : null;
}

/** Free memory % from macOS `memory_pressure` (absolute path: servers run with a bare PATH); null if it can't be read. */
export function readFreeMemoryPct(): number | null {
  try {
    return parseFreeMemoryPct(execFileSync('/usr/bin/memory_pressure', { encoding: 'utf8', timeout: 5000 }));
  } catch {
    return null;
  }
}

/** Below this share of free memory, no new analysis engine is started (Mac limits). */
export const MIN_FREE_MEMORY_PCT = 20;

/**
 * Wraps an engine factory so that every engine start first checks free memory, and throws a
 * plain message instead of starting Stockfish when it is below `minPct` or can't be read.
 * Used for the analysis engine: the runner only builds one when a game is not cached yet, so
 * work that needs no engine is never refused.
 */
export function memoryGuarded<T>(
  factory: () => T,
  freePct: () => number | null = readFreeMemoryPct,
  minPct: number = MIN_FREE_MEMORY_PCT,
): () => T {
  return () => {
    const free = freePct();
    if (free === null) throw new Error('could not read free memory (memory_pressure), so Stockfish was not started');
    if (free < minPct) {
      throw new Error(`only ${free}% of memory is free and the analysis needs at least ${minPct}%; close some apps first`);
    }
    return factory();
  };
}
