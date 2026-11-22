import type { Engine, Evaluation } from '../../../src/services/engine/types';
import { DISPLAY_CFG, ENGINE_CFG } from '../config';
import { createNativeStockfish, type NativeStockfish } from './nativeStockfish';

declare const DISPLAY_DEPTH: unique symbol;

/**
 * An engine that searches at DISPLAY_CFG depth, for every position that is shown or drilled.
 * A distinct type that only `createDisplayEngine` (and `guardDisplayEngine`, which wraps one)
 * produces, so the quick analysis engine (ENGINE_CFG) can't be passed where a deep search is
 * required. The mark exists only for the type checker.
 */
export type DisplayEngine<E extends Engine = Engine> = E & { readonly [DISPLAY_DEPTH]: true };

/** What a display engine is built with: ENGINE_CFG's threads and hash, DISPLAY_CFG's time and lines. */
export type DisplaySettings = typeof ENGINE_CFG;

/**
 * The display engine: native Stockfish with DISPLAY_CFG by default. `make` builds another
 * engine from the same settings (tests use it to pass a fake).
 */
export function createDisplayEngine(): DisplayEngine<NativeStockfish>;
export function createDisplayEngine<E extends Engine>(make: (cfg: DisplaySettings) => E): DisplayEngine<E>;
export function createDisplayEngine(make: (cfg: DisplaySettings) => Engine = (cfg) => createNativeStockfish(cfg)): DisplayEngine {
  return make({ ...ENGINE_CFG, ...DISPLAY_CFG }) as DisplayEngine;
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
