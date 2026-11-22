import { randomUUID } from 'node:crypto';
import { analyzeGame } from '../../../src/analysis/analyzeGame';
import type { Engine, Evaluation } from '../../../src/services/engine/types';
import type { TimeClass } from '../../../src/types';
import { ENGINE_CFG } from '../config';
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
  /**
   * Games `analyzeGame` threw on without any engine failure (bad PGN, or a code bug). Never cached,
   * so every later `start` retries them. More than 10% of the list, or every game, makes the job `error`.
   */
  skipped?: number;
  skippedIds?: string[];
  /** The first skipped game's error message. */
  skipReason?: string;
}

export interface RunnerOptions {
  /** Max time for one engine search before it counts as a hung engine. Default max(10 s, 50 x movetime). */
  evaluateTimeoutMs?: number;
}

/** More than this share of skipped games means something systematic is wrong, not a few odd PGNs. */
const MAX_SKIP_SHARE = 0.1;

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
  /** Cached analyses for the query's games (fresh game metadata), deduped, oldest to newest. Uses the list from the last start of that query, so no network call after a start. */
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

export function createRunner(
  engineFactory: EngineFactory,
  source: GameSource,
  opts: RunnerOptions = {},
): Runner {
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? Math.max(10_000, 50 * ENGINE_CFG.movetimeMs);
  /** Game lists by query, from the last start/load: load() answers from here without touching the network. */
  const lists = new Map<string, CoachGame[]>();
  const jobs = new Map<string, Job>();
  /** Starts that are still fetching their list or running, by query: a repeat of the same query joins them. */
  const active = new Map<string, Promise<Started>>();
  let engine: RunnerEngine | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function fetchList(q: Query): Promise<CoachGame[]> {
    const games = dedupeSort(
      await source.fetchGames(q.usernames, {
        timeClass: q.timeClass,
        maxGames: q.maxGames,
        before: q.before,
      }),
    );
    lists.set(queryKey(q), games);
    return games;
  }

  /** `evaluate` that rejects if the engine takes too long: a hung Stockfish is an engine failure too. */
  function withTimeout(call: Promise<Evaluation>): Promise<Evaluation> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Stockfish did not answer within ${evaluateTimeoutMs} ms (hung)`)),
        evaluateTimeoutMs,
      );
      call.then(
        (v) => (clearTimeout(timer), resolve(v)),
        (e) => (clearTimeout(timer), reject(e)),
      );
    });
  }

  async function dropEngine(): Promise<void> {
    const old = engine;
    engine = null;
    try {
      // A hung engine must not stall the recreate either.
      await Promise.race([
        Promise.resolve(old?.close?.()),
        new Promise((r) => setTimeout(r, 5_000).unref()),
      ]);
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
            return await withTimeout(Promise.resolve(current.evaluate(fen, ms)));
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
          const st = job.status;
          st.skipped = (st.skipped ?? 0) + 1;
          (st.skippedIds ??= []).push(g.id);
          st.skipReason ??= e.message;
          // Past the share limit it can no longer recover, so stop now instead of burning the whole list.
          if (st.skipped > st.total * MAX_SKIP_SHARE) throw skipFailure(st);
        }
        job.status.done++;
      }
      const st = job.status;
      if (st.skipped !== undefined && st.skipped === todo.length) throw skipFailure(st);
      st.state = 'done';
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
          status: { done: cached, total: games.length, state: todo.length === 0 ? 'done' : 'running' },
          finished: Promise.resolve(),
        };
        jobs.set(jobId, job);
        if (todo.length === 0) return { jobId, total: games.length, cached }; // nothing to wait behind
        // Queue behind any running job (one Stockfish at a time), without blocking the caller.
        job.finished = queue = queue
          .then(() => run(job, todo))
          .finally(() => active.delete(key));
        return { jobId, total: games.length, cached };
      })();
      active.set(key, starting);
      // A failed list fetch, or a job with nothing to run, must not keep the key joinable.
      starting.then(
        (r) => {
          if (jobs.get(r.jobId)?.status.state !== 'running') active.delete(key);
        },
        () => active.delete(key),
      );
      return starting;
    },

    status(jobId) {
      const job = jobs.get(jobId);
      if (!job) return { done: 0, total: 0, state: 'error', error: `Unknown job ${jobId}` };
      return { ...job.status };
    },

    async load(q) {
      const games = lists.get(queryKey(q)) ?? (await fetchList(q));
      const out: CachedGame[] = [];
      for (const g of games) {
        const c = readCached(g.id);
        // Fresh game metadata (myPreRating depends on the fetch window), cached analysis.
        if (c) out.push({ game: g, analysis: c.analysis });
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

function skipFailure(st: JobStatus): Error {
  return new Error(`${st.skipped} of ${st.total} games could not be analysed: ${st.skipReason}`);
}

/** A failure caused by the game itself (not the engine); the game is skipped and counted. */
class GameError extends Error {}
