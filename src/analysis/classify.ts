import { DELTA, GREAT_MOVE, MISSED_WIN } from '../constants';
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

/**
 * Chess.com-style "Great move": the played move was the engine's best AND the
 * second-best line is significantly worse — there was effectively only one
 * good move. Both win% values are from the mover's POV; `gapPct` defaults to
 * `GREAT_MOVE.minWinPctGap`.
 */
export function isGreatMove(
  winBestMover: number,
  winSecondBestMover: number | null,
  gapPct: number = GREAT_MOVE.minWinPctGap,
): boolean {
  return (
    winSecondBestMover !== null && winBestMover - winSecondBestMover >= gapPct
  );
}
