import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Engine, Evaluation, SecondBestLine } from '../../../src/services/engine/types';
import { parseBestmove, parseUciInfo } from '../../../src/services/engine/uci';
import { ENGINE_CFG, loadLocalConfig } from '../config';

type Proc = ChildProcessByStdio<Writable, Readable, null>;

export type NativeStockfishOptions = Partial<typeof ENGINE_CFG> & { path?: string };

export interface NativeStockfish extends Engine {
  /** Terminate the Stockfish child process. Safe to call more than once. */
  close(): Promise<void>;
  /** Number of completed searches so far. */
  positionsSearched(): number;
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
 *
 * The binary path comes from `opts.path`, else `loadLocalConfig().stockfishPath`.
 * The process is started lazily on the first `evaluate`; a missing binary makes
 * that call reject with an install hint. Always call `close()` when done.
 */
export function createNativeStockfish(opts: NativeStockfishOptions = {}): NativeStockfish {
  const cfg = { ...ENGINE_CFG, ...stripUndefined(opts) };
  const path = opts.path ?? loadLocalConfig().stockfishPath;

  let child: Proc | null = null;
  let started: Promise<void> | null = null;
  let closed = false;
  let searched = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let buffer = '';
  const listeners = new Set<(line: string) => void>();
  /** Rejects whoever is currently waiting when the process dies. */
  const failures = new Set<(err: Error) => void>();

  function fail(err: Error): void {
    for (const f of [...failures]) f(err);
  }

  function spawnChild(): Promise<Proc> {
    return new Promise((resolve, reject) => {
      const proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      proc.once('error', (e: NodeJS.ErrnoException) => {
        const err =
          e.code === 'ENOENT'
            ? new Error(`Stockfish not found at ${path}. Install it with: brew install stockfish`)
            : e;
        reject(err);
        fail(err);
      });
      proc.once('spawn', () => resolve(proc));
      proc.once('exit', (code, signal) => {
        if (!closed) fail(new Error(`Stockfish exited unexpectedly (code ${code}, signal ${signal})`));
      });
      proc.stdin.on('error', () => undefined); // EPIPE after kill is expected
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
    if (!started) {
      started = (async () => {
        if (closed) throw new Error('Stockfish adapter is closed');
        child = await spawnChild();
        if (closed) {
          child.kill();
          throw new Error('Stockfish adapter is closed');
        }
        await waitFor((l) => l === 'uciok', 'uci');
        send(`setoption name Threads value ${cfg.threads}`);
        send(`setoption name Hash value ${cfg.hashMb}`);
        send(`setoption name MultiPV value ${cfg.multiPv}`);
        await waitFor((l) => l === 'readyok', 'isready');
      })();
    }
    return started;
  }

  function search(fen: string): Promise<Evaluation> {
    return new Promise((resolve, reject) => {
      const tiers: Record<number, { cp: number | null; mate: number | null; pv: string[] | null }> = {};
      const onLine = (line: string) => {
        const info = parseUciInfo(line);
        if (info) {
          tiers[info.tier] = { cp: info.cp, mate: info.mate, pv: info.pv };
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
        resolve({
          cp: top.cp,
          mate: top.mate,
          bestMoveUci: parseBestmove(line),
          secondBest,
          pvUci: top.pv ?? null,
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
      send(`go movetime ${cfg.movetimeMs}`);
    });
  }

  async function evaluate(fen: string, _movetimeMs: number): Promise<Evaluation> {
    const run = chain.then(async () => {
      await ensureStarted();
      return search(fen);
    });
    chain = run.catch(() => undefined);
    return run;
  }

  async function close(): Promise<void> {
    closed = true;
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
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
  }

  return { evaluate, close, positionsSearched: () => searched };
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
