import type { Classification, Color } from '../../../src/types';

/**
 * Everything the coach knows about one move in one game. Built by `positionFacts` (from the
 * cache) and `deepPositionFacts` (re-searched at DISPLAY_CFG) in coaching/explain.ts.
 *
 * Shape fixed by plan Task C1. The board views (server/views.ts) read it as follows, which the
 * builders must honour:
 * - `bestSan`/`bestUci` are null when the played move was the best move (as in the root
 *   `PlyAnalysis.bestMoveSan`).
 * - `winBefore`/`winAfter` are the mover's win chance, 0..100, before and after the played move.
 */
export interface PositionFacts { gameId: string; ply: number; fenBefore: string; fenAfter: string; mover: Color;
  playedSan: string; playedUci: string; bestSan: string|null; bestUci: string|null; bestLineSan: string[]|null;
  refutationSan: string[]|null;   // opponent's best line after the played move = plies[ply+1].bestLineSan
  winBefore: number; winAfter: number; classification: Classification; reason: string|null; gameUrl: string }
