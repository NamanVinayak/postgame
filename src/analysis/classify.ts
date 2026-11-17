import { DELTA, GREAT_MOVE, MISS, MISSED_WIN } from '../constants';
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

/**
 * True when the engine's best move would have left the mover clearly winning
 * and the played move left the game roughly equal or worse — the mover missed
 * the chance to capitalize and gain a winning position (Chess.com's
 * "Missed Win"). Both win% values are from the mover's POV; `winBeforeMover`
 * is the win% the best move would have reached.
 */
export function isMissedWin(winBeforeMover: number, winAfterMover: number): boolean {
  return (
    winBeforeMover >= MISSED_WIN.winningWinPct && winAfterMover <= MISSED_WIN.dropTo
  );
}

/**
 * True when the best move would have gained a clear edge and the played move
 * left the game level or worse — a missed opportunity to punish the
 * opponent (Chess.com's "Miss"). Unlike a missed win, the position was not
 * already won; the swing alone (best vs played) must clear `minSwing`.
 * Callers check missed win first; a move is never both.
 */
export function isMiss(winBeforeMover: number, winAfterMover: number): boolean {
  return (
    winBeforeMover >= MISS.gainWinPct &&
    winAfterMover <= MISS.dropTo &&
    winBeforeMover - winAfterMover >= MISS.minSwing
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
