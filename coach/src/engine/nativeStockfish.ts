import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Engine, Evaluation, SecondBestLine } from '../../../src/services/engine/types';
import { parseBestmove, parseUciInfo } from '../../../src/services/engine/uci';
import { ENGINE_CFG, loadLocalConfig } from '../config';

type Proc = ChildProcessByStdio<Writable, Readable, null>;

export type NativeStockfishOptions = Partial<typeof ENGINE_CFG> & {
  path?: string;
  /**
   * Search to this fixed depth instead of for `movetimeMs`, starting each search from a fresh
   * game (`ucinewgame`, which clears the hash and history). With one thread this makes every
   * search of a position give the same answer (used by the display engine).
   */
  depth?: number;
  /**
   * Time cap on a fixed-depth search, in ms (default 10 s; rarely hit). A search it cuts short
   * is still returned, marked `capped`.
   */
  capMs?: number;
};

/** The settings an adapter searches with (its own copy, so callers can key results on them). */
export type NativeSettings = typeof ENGINE_CFG & { depth?: number; capMs?: number };

/** An evaluation plus how far the search got. */
export interface NativeEvaluation extends Evaluation {
  /** Deepest `info depth` reported for the best line; null if none. */
  depth: number | null;
  /**
   * True when a fixed-depth search stopped before its depth (the time cap hit). Its answer is
   * time-dependent, so it must not be stored as the depth-N answer. Always false for a timed search.
   */
  capped: boolean;
}

/** Default time cap on a fixed-depth search (rarely hit: depth 16 takes 1-2 s on a middlegame). */
export const DEPTH_CAP_MS = 10_000;

export interface NativeStockfish extends Engine {
  evaluate(fen: string, movetimeMs: number): Promise<NativeEvaluation>;
  /** The engine's `id name` (e.g. "Stockfish 19"), starting the process if needed. */
  engineId(): Promise<string>;
  /** The settings this adapter searches with. */
  settings(): NativeSettings;
  /**
   * Terminate the Stockfish child process and wait for it to exit. In-flight and
   * later `evaluate` calls reject. Safe to call more than once.
   */
  close(): Promise<void>;
  /** Number of completed searches so far. */
  positionsSearched(): number;
  /** OS pid of the child process, or null if it is not running (mainly for tests). */
  pid(): number | null;
}

/**
 * An Engine backed by a native Stockfish binary (one child process per adapter).
 *
 * Mirrors the browser adapter's Evaluation semantics: scores are from the
 * side-to-move's point of view, `secondBest` is filled from MultiPV tier 2, and
 * `pvUci` is the PV of tier 1. Searches are serialized (one at a time).
 *
 * NOTE: the `movetimeMs` argument of `evaluate` is IGNORED. The search time is
 * fixed per adapter by `opts.movetimeMs` (default `ENGINE_CFG.movetimeMs`) so
 * that every caller of `analyzeGame` gets the same, configured search budget.
 * With `opts.depth`, each search is `ucinewgame` + `go depth N movetime <capMs>` instead; a
 * search stopped by the cap before depth N is returned with `capped: true`.
 *
 * The binary path comes from `opts.path`, else `loadLocalConfig().stockfishPath`.
 * The process is started lazily on the first `evaluate`; a missing binary makes
 * that call reject with an install hint. If the process dies (or `close()` is
 * called) every pending and later `evaluate` rejects promptly instead of hanging.
 * Always call `close()` when done.
 */
export function createNativeStockfish(opts: NativeStockfishOptions = {}): NativeStockfish {
  const cfg = { ...ENGINE_CFG, ...stripUndefined(opts) };
  const path = opts.path ?? loadLocalConfig().stockfishPath;
  const capMs = cfg.capMs ?? DEPTH_CAP_MS;

  let child: Proc | null = null;
  /** True from spawn() until the process exits or fails to start. */
  let alive = false;
  /** Once set, the adapter is unusable and every evaluate rejects with this. */
  let dead: Error | null = null;
  let started: Promise<void> | null = null;
  /** From the `id name` line of the UCI handshake. */
  let engineName = 'unknown engine';
  let searched = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let buffer = '';
  const listeners = new Set<(line: string) => void>();
  /** Rejects whoever is currently waiting when the process dies. */
  const failures = new Set<(err: Error) => void>();

  function die(err: Error): void {
    alive = false;
    dead ??= err;
    for (const f of [...failures]) f(dead);
  }

  /** Spawns synchronously (so `child` is set at once); resolves when the process is up. */
  function spawnChild(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      child = proc;
      alive = true;
      proc.once('error', (e: NodeJS.ErrnoException) => {
        const err =
          e.code === 'ENOENT'
            ? new Error(`Stockfish not found at ${path}. Install it with: brew install stockfish`)
            : e;
        die(err);
        reject(err);
      });
      proc.once('spawn', () => resolve());
      proc.once('exit', (code, signal) => {
        const err =
          dead ??
          new Error(`Stockfish exited unexpectedly (code ${code}, signal ${signal})`);
        die(err);
        reject(err);
      });
      proc.stdin.on('error', () => undefined); // EPIPE after the process died
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) for (const l of [...listeners]) l(line);
        }
      });
    });
  }

  function send(cmd: string): void {
    child?.stdin.write(`${cmd}\n`);
  }

  /** Send `command`, resolve when a line satisfying `isDone` arrives. */
  function waitFor(isDone: (line: string) => boolean, command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const onLine = (line: string) => {
        if (isDone(line)) {
          cleanup();
          resolve();
        }
      };
      const onFail = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        listeners.delete(onLine);
        failures.delete(onFail);
      };
      listeners.add(onLine);
      failures.add(onFail);
      send(command);
    });
  }

  function ensureStarted(): Promise<void> {
    if (dead) return Promise.reject(dead);
    if (!started) {
      started = (async () => {
        await spawnChild();
        const onId = (l: string) => {
          if (l.startsWith('id name ')) engineName = l.slice('id name '.length).trim();
        };
        listeners.add(onId);
        try {
          await waitFor((l) => l === 'uciok', 'uci');
        } finally {
          listeners.delete(onId);
        }
        send(`setoption name Threads value ${cfg.threads}`);
        send(`setoption name Hash value ${cfg.hashMb}`);
        send(`setoption name MultiPV value ${cfg.multiPv}`);
        await waitFor((l) => l === 'readyok', 'isready');
      })();
      started.catch(() => undefined); // surfaced through evaluate; avoid unhandled rejection
    }
    return started;
  }

  function search(fen: string): Promise<NativeEvaluation> {
    return new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const tiers: Record<number, { cp: number | null; mate: number | null; pv: string[] | null }> = {};
      let reached: number | null = null;
      let t0 = 0;
      const onLine = (line: string) => {
        const info = parseUciInfo(line);
        if (info) {
          tiers[info.tier] = { cp: info.cp, mate: info.mate, pv: info.pv };
          const d = /\bdepth (\d+)/.exec(line);
          if (info.tier === 1 && d) reached = Math.max(reached ?? 0, Number(d[1]));
          return;
        }
        if (!line.startsWith('bestmove')) return;
        cleanup();
        const top = tiers[1] ?? { cp: null, mate: null, pv: null };
        let secondBest: SecondBestLine | null = null;
        if (tiers[2]) {
          secondBest = {
            cp: tiers[2].cp,
            mate: tiers[2].mate,
            bestMoveUci: tiers[2].pv && tiers[2].pv[0] ? tiers[2].pv[0] : null,
          };
        }
        searched++;
        // Cut short: below the depth asked for, or stopped by the cap (a little early counts too:
        // wrongly calling a search capped only costs a re-search, the opposite would store a partial one).
        const capped =
          cfg.depth !== undefined && ((reached ?? 0) < cfg.depth || Date.now() - t0 >= capMs - 50);
        resolve({
          cp: top.cp,
          mate: top.mate,
          bestMoveUci: parseBestmove(line),
          secondBest,
          pvUci: top.pv ?? null,
          depth: reached,
          capped,
        });
      };
      const onFail = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        listeners.delete(onLine);
        failures.delete(onFail);
      };
      listeners.add(onLine);
      failures.add(onFail);
      send(`position fen ${fen}`);
      t0 = Date.now();
      send(cfg.depth !== undefined ? `go depth ${cfg.depth} movetime ${capMs}` : `go movetime ${cfg.movetimeMs}`);
    });
  }

  async function evaluate(fen: string, _movetimeMs: number): Promise<NativeEvaluation> {
    const run = chain.then(async () => {
      await ensureStarted();
      if (cfg.depth !== undefined) {
        // A fresh game before each fixed-depth search: nothing from earlier searches can change the answer.
        send('ucinewgame');
        await waitFor((l) => l === 'readyok', 'isready');
      }
      return search(fen);
    });
    chain = run.catch(() => undefined);
    return run;
  }

  async function close(): Promise<void> {
    // Mark unusable first so pending/queued/later evaluates reject with a clear reason.
    dead ??= new Error('Stockfish adapter is closed');
    const proc = child;
    if (!proc || !alive) return;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      try {
        proc.stdin.write('quit\n');
      } catch {
        /* ignore */
      }
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 2000).unref();
    });
    die(dead); // reject anything still waiting
  }

  async function engineId(): Promise<string> {
    await ensureStarted();
    return engineName;
  }

  const { path: _path, ...settings } = cfg;
  return {
    evaluate,
    engineId,
    settings: () => ({ ...settings }),
    close,
    positionsSearched: () => searched,
    pid: () => (alive ? (child?.pid ?? null) : null),
  };
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
