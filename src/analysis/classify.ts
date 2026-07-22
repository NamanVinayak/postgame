import { DELTA, MISSED_WIN } from '../constants';
import type { Classification } from '../types';

/**
 * Classify a move by how much win probability it gave up (mover POV, in
 * percentage points). The engine's own top move is always "best".
 */
export function classifyMove(winPctLost: number, playedIsBest: boolean): Classification {
  if (playedIsBest || winPctLost < DELTA.good) return 'best';
  if (winPctLost < DELTA.inaccuracy) return 'good';
  if (winPctLost < DELTA.mistake) return 'inaccuracy';
  if (winPctLost < DELTA.blunder) return 'mistake';
  return 'blunder';
}

/** True when the mover was clearly winning and let it slip to roughly equal. */
export function isMissedWin(winBeforeMover: number, winAfterMover: number): boolean {
  return (
    winBeforeMover >= MISSED_WIN.winningWinPct && winAfterMover <= MISSED_WIN.dropTo
  );
}
