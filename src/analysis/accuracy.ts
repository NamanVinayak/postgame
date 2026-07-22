function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Per-move accuracy (0..100) from the win% before/after the move (mover POV).
 * Documented approximation of the Lichess/Chess.com accuracy curve — not their
 * exact proprietary formula.
 */
export function moveAccuracy(winBeforeMover: number, winAfterMover: number): number {
  const drop = winBeforeMover - winAfterMover;
  const accuracy = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return clamp(accuracy, 0, 100);
}

/** Mean of per-move accuracies; 100 when there were no moves. */
export function gameAccuracy(moveAccuracies: number[]): number {
  if (moveAccuracies.length === 0) return 100;
  const sum = moveAccuracies.reduce((a, b) => a + b, 0);
  return sum / moveAccuracies.length;
}
