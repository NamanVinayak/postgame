import { randomUUID } from 'node:crypto';
import { analyzeGame } from '../../../src/analysis/analyzeGame';
import type { Engine, Evaluation } from '../../../src/services/engine/types';
import type { TimeClass } from '../../../src/types';
import type { CoachGame, GameSource } from '../sources/types';
import { readCached, writeCached, type CachedGame } from './cache';

export type { CachedGame } from './cache';

export interface Query {
  usernames: string[];
  timeClass: TimeClass;
  maxGames: number;
  before?: number;
}

export interface JobStatus {
  /** Games finished so far: cached, analysed, or skipped. */
  done: number;
  total: number;
  state: 'running' | 'done' | 'error';
  error?: string;
  /** Games dropped because their PGN could not be analysed (never because of the engine). */
  skipped?: number;
}

export type RunnerEngine = Engine & { close?(): Promise<void> | void };
/** Builds a fresh engine. The runner calls it lazily, and once more if the engine process dies. */
export type EngineFactory = () => RunnerEngine;

export interface Runner {
  /**
   * Fetches the game list, then analyses the missing games in the background and returns.
   * Async (unlike the first sketch) because the game list comes from the network.
   * One job runs at a time: a start with the SAME query as a running/queued job joins it
   * (same jobId); a different query queues behind it.
   */
  start(q: Query): Promise<{ jobId: string; total: number; cached: number }>;
  status(jobId: string): JobStatus;
  /** Cached games matching the query, deduped by id, oldest to newest. Async: it asks the source for the list. */
  load(q: Query): Promise<CachedGame[]>;
  /** Resolves when the job finishes (done or error). */
  wait(jobId: string): Promise<JobStatus>;
  /** Closes the engine, if one was started. */
  close(): Promise<void>;
}

interface Job {
  status: JobStatus;
  finished: Promise<void>;
}

type Started = { jobId: string; total: number; cached: number };

const queryKey = (q: Query) =>
  JSON.stringify([[...q.usernames].sort(), q.timeClass, q.maxGames, q.before ?? null]);

/** Unique by id (first one wins), then oldest to newest. */
function dedupeSort(games: CoachGame[]): CoachGame[] {
  const seen = new Set<string>();
  const out: CoachGame[] = [];
  for (const g of games) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push(g);
  }
  return out.sort((a, b) => a.endTime - b.endTime);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRunner(engineFactory: EngineFactory, source: GameSource): Runner {
  const jobs = new Map<string, Job>();
  /** Starts that are still fetching their list or running, by query: a repeat of the same query joins them. */
  const active = new Map<string, Promise<Started>>();
  let engine: RunnerEngine | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function fetchList(q: Query): Promise<CoachGame[]> {
    const games = await source.fetchGames(q.usernames, {
      timeClass: q.timeClass,
      maxGames: q.maxGames,
      before: q.before,
    });
    return dedupeSort(games);
  }

  async function dropEngine(): Promise<void> {
    const old = engine;
    engine = null;
    try {
      await old?.close?.();
    } catch {
      // already dead
    }
  }

  /** Analyses one game; recreates the engine once and retries if an engine call fails. */
  async function analyseWithRetry(g: CoachGame): Promise<CachedGame> {
    for (let attempt = 0; ; attempt++) {
      engine ??= engineFactory();
      let engineError: unknown = null;
      const current = engine;
      const watched: Engine = {
        evaluate: async (fen, ms): Promise<Evaluation> => {
          try {
            return await current.evaluate(fen, ms);
          } catch (e) {
            engineError = e;
            throw e;
          }
        },
      };
      try {
        return { game: g, analysis: await analyzeGame(g.pgn, watched, g.id) };
      } catch (e) {
        if (engineError === null) throw new GameError(msg(e)); // bad PGN, not the engine
        await dropEngine();
        if (attempt >= 1) throw new Error(msg(engineError));
      }
    }
  }

  async function run(job: Job, todo: CoachGame[]): Promise<void> {
    try {
      for (const g of todo) {
        // A job queued earlier may have analysed this game since the list was made.
        if (readCached(g.id) !== null) {
          job.status.done++;
          continue;
        }
        try {
          writeCached(await analyseWithRetry(g));
        } catch (e) {
          if (!(e instanceof GameError)) throw e;
          job.status.skipped = (job.status.skipped ?? 0) + 1;
        }
        job.status.done++;
      }
      job.status.state = 'done';
    } catch (e) {
      job.status.state = 'error';
      job.status.error = msg(e);
    }
  }

  return {
    start(q) {
      const key = queryKey(q);
      const existing = active.get(key);
      if (existing) return existing;
      const starting = (async (): Promise<Started> => {
        const games = await fetchList(q);
        const todo = games.filter((g) => readCached(g.id) === null);
        const cached = games.length - todo.length;
        const jobId = randomUUID();
        const job: Job = {
          status: { done: cached, total: games.length, state: 'running' },
          finished: Promise.resolve(),
        };
        jobs.set(jobId, job);
        // Queue behind any running job (one Stockfish at a time), without blocking the caller.
        job.finished = queue = queue
          .then(() => run(job, todo))
          .finally(() => active.delete(key));
        return { jobId, total: games.length, cached };
      })();
      active.set(key, starting);
      starting.catch(() => active.delete(key)); // a failed list fetch must not block a retry
      return starting;
    },

    status(jobId) {
      const job = jobs.get(jobId);
      if (!job) return { done: 0, total: 0, state: 'error', error: `Unknown job ${jobId}` };
      return { ...job.status };
    },

    async load(q) {
      const out: CachedGame[] = [];
      for (const g of await fetchList(q)) {
        const c = readCached(g.id);
        if (c) out.push(c);
      }
      return out;
    },

    async wait(jobId) {
      await jobs.get(jobId)?.finished;
      return this.status(jobId);
    },

    async close() {
      await queue;
      await dropEngine();
    },
  };
}

/** A failure caused by the game itself (not the engine); the game is skipped and counted. */
class GameError extends Error {}
