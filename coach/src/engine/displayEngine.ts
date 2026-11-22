import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine, Evaluation } from '../../../src/services/engine/types';
import { DISPLAY_CFG, ENGINE_CFG, coachHome } from '../config';
import { createNativeStockfish, type NativeStockfish } from './nativeStockfish';

declare const DISPLAY_DEPTH: unique symbol;

/**
 * An engine that searches at DISPLAY_CFG depth, for every position that is shown or drilled.
 * A distinct type that only `createDisplayEngine` (and `guardDisplayEngine`, which wraps one)
 * produces, so the quick analysis engine (ENGINE_CFG) can't be passed where a deep search is
 * required. The mark exists only for the type checker.
 */
export type DisplayEngine<E extends Engine = Engine> = E & { readonly [DISPLAY_DEPTH]: true };

/** What a display engine is built with (DISPLAY_CFG over ENGINE_CFG): one thread, fixed hash, fixed depth. */
export type DisplaySettings = typeof ENGINE_CFG & { depth: number };
export const DISPLAY_SETTINGS: DisplaySettings = { ...ENGINE_CFG, ...DISPLAY_CFG };

/**
 * The display engine. With no argument (production): native Stockfish with DISPLAY_SETTINGS, a
 * deterministic fixed-depth search, whose results are kept on disk under coachHome()/deep/
 * (`persistDisplayEngine`), so a position gets the same answer after a restart too.
 *
 * `make` is a TEST SEAM: it builds any engine from the same settings and brands it, without
 * the disk store. Production code always calls `createDisplayEngine()` with no argument.
 */
export function createDisplayEngine(): DisplayEngine<NativeStockfish>;
export function createDisplayEngine<E extends Engine>(make: (cfg: DisplaySettings) => E): DisplayEngine<E>;
export function createDisplayEngine(make?: (cfg: DisplaySettings) => Engine): DisplayEngine {
  if (make) return make({ ...DISPLAY_SETTINGS }) as DisplayEngine;
  return persistDisplayEngine(createNativeStockfish(DISPLAY_SETTINGS) as DisplayEngine<NativeStockfish>, createDeepStore());
}

/** Board, side to move, castling and en passant: the position without its move counters. */
export function normaliseFen(fen: string): string {
  return fen.trim().split(/\s+/, 4).join(' ');
}

/** The settings that decide a deep result; they are part of each stored result's key. */
type DeepKey = Pick<DisplaySettings, 'depth' | 'threads' | 'hashMb' | 'multiPv'>;

/** Stored results of another format are ignored (and searched again). */
const DEEP_FORMAT = 1;

/** Deep results kept between runs. */
export interface DeepStore {
  get(fen: string): Evaluation | null;
  set(fen: string, evaluation: Evaluation): void;
}

const isNumOrNull = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x));
const isStrOrNull = (x: unknown) => x === null || typeof x === 'string';

/** A stored evaluation as written by `set`; anything else is treated as missing. */
function isEvaluation(x: unknown): x is Evaluation {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  const sb = e.secondBest as Record<string, unknown> | null | undefined;
  return (
    isNumOrNull(e.cp) &&
    isNumOrNull(e.mate) &&
    isStrOrNull(e.bestMoveUci) &&
    (e.pvUci === null || (Array.isArray(e.pvUci) && e.pvUci.every((m) => typeof m === 'string'))) &&
    (sb === null || (typeof sb === 'object' && isNumOrNull(sb?.cp) && isNumOrNull(sb?.mate) && isStrOrNull(sb?.bestMoveUci)))
  );
}

/**
 * Deep results on disk: one JSON file per (normalised FEN, display settings) under
 * `coachHome()/deep/` (read when used, so a test's temporary home is respected), named by the
 * sha256 of the format, the position and the settings. Written to a temp file and renamed, so
 * a killed process never leaves half a file. A file that can't be read, or that belongs to
 * another position or settings, counts as missing. A failed write is ignored: the answer is
 * still deterministic, it just gets searched again next time.
 */
export function createDeepStore(settings: DeepKey = DISPLAY_SETTINGS): DeepStore {
  const key: DeepKey = { depth: settings.depth, threads: settings.threads, hashMb: settings.hashMb, multiPv: settings.multiPv };
  const dir = () => join(coachHome(), 'deep');
  const fileFor = (fen: string) =>
    join(dir(), `${createHash('sha256').update(JSON.stringify([DEEP_FORMAT, normaliseFen(fen), key])).digest('hex')}.json`);
  return {
    get(fen) {
      try {
        const stored = JSON.parse(readFileSync(fileFor(fen), 'utf8')) as Record<string, unknown>;
        const same =
          stored.format === DEEP_FORMAT &&
          stored.fen === normaliseFen(fen) &&
          JSON.stringify(stored.settings) === JSON.stringify(key);
        return same && isEvaluation(stored.evaluation) ? stored.evaluation : null;
      } catch {
        return null;
      }
    },
    set(fen, evaluation) {
      const file = fileFor(fen);
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        mkdirSync(dir(), { recursive: true });
        writeFileSync(tmp, JSON.stringify({ format: DEEP_FORMAT, fen: normaliseFen(fen), settings: key, evaluation }));
        renameSync(tmp, file);
      } catch {
        rmSync(tmp, { force: true });
      }
    },
  };
}

/**
 * The same display engine, keeping every result in `store`: a position searched once (in any
 * run) is answered from the store from then on, without a search. The search is made on the
 * normalised position with fresh move counters ("… 0 1"), so a stored answer depends only on
 * its key, whichever game the position first came from. The engine's other methods (close,
 * pid, positionsSearched) pass through; positionsSearched counts real searches only.
 */
export function persistDisplayEngine<E extends Engine>(
  engine: DisplayEngine<E>,
  store: DeepStore,
): DisplayEngine<Omit<E, 'evaluate'> & Engine> {
  async function evaluate(fen: string, ms: number): Promise<Evaluation> {
    const known = store.get(fen);
    if (known) return known;
    const result = await engine.evaluate(`${normaliseFen(fen)} 0 1`, ms);
    store.set(fen, result);
    return result;
  }
  return Object.assign({}, engine, { evaluate }) as DisplayEngine<Omit<E, 'evaluate'> & Engine>;
}

/** Searches remembered by `memoDisplayEngine`, keyed by search time and position. */
export type SearchMemo = Map<string, Promise<Evaluation>>;

/** Searches kept per memo; past this the oldest are forgotten (a session shows far fewer). */
export const SEARCH_MEMO_MAX = 4000;

/**
 * The same display engine, remembering each position's search for as long as `memo` lives
 * (the server keeps one for its whole session). Two-thread Stockfish can choose between
 * equally good moves differently on two runs, so without this the same position could get a
 * different "best move" when it is explained, asked, checked or put on the report.
 *
 * Keyed by the board, side to move, castling and en passant (not the move counters), so the
 * same position reached in two games gets the same answer. Concurrent requests for one
 * position share a single search. A failed search is forgotten, so it can be tried again.
 */
export function memoDisplayEngine(engine: DisplayEngine, memo: SearchMemo): DisplayEngine {
  const memoed: Engine = {
    evaluate(fen: string, ms: number): Promise<Evaluation> {
      const key = `${ms} ${fen.split(' ', 4).join(' ')}`;
      const known = memo.get(key);
      if (known) return known;
      const p = Promise.resolve(engine.evaluate(fen, ms));
      memo.set(key, p);
      p.catch(() => {
        if (memo.get(key) === p) memo.delete(key);
      });
      while (memo.size > SEARCH_MEMO_MAX) memo.delete(memo.keys().next().value as string);
      return p;
    },
  };
  return memoed as DisplayEngine;
}

/**
 * The same display engine with a time limit on each search. `onFailure` runs when a search
 * fails or runs out of time (the caller then drops the engine). Still a display engine: it
 * searches with the wrapped one.
 */
export function guardDisplayEngine(engine: DisplayEngine, timeoutMs: number, onFailure: () => void): DisplayEngine {
  const guarded: Engine = {
    async evaluate(fen: string, ms: number): Promise<Evaluation> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve(engine.evaluate(fen, ms)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Stockfish did not answer within ${Math.round(timeoutMs / 1000)} s`)),
              timeoutMs,
            );
          }),
        ]);
      } catch (e) {
        onFailure();
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return guarded as DisplayEngine;
}
