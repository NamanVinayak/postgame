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
