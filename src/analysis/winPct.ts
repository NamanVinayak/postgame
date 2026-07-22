import { WINPCT_K } from '../constants';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Convert an engine evaluation (White POV) to White's win probability, 0..100.
 * Centipawns pass through a logistic curve; a forced mate is a certainty.
 */
export function evalToWinPct(cp: number | null, mate: number | null): number {
  if (mate !== null) return mate > 0 ? 100 : 0;
  const centipawns = cp ?? 0;
  const winPct = 50 + 50 * (2 / (1 + Math.exp(-WINPCT_K * centipawns)) - 1);
  return clamp(winPct, 0, 100);
}
