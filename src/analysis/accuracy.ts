import type { Color } from '../types';

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

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation; small windows are treated as low-volatility. */
function stdev(xs: number[]): number {
  if (xs.length <= 1) return 0.5;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export interface MoveScore {
  color: Color;
  accuracy: number;
}

/**
 * Game accuracy per color, following the Lichess method: the average of a
 * **volatility-weighted mean** (positions where the evaluation was swinging
 * count for more — that's where accuracy actually matters) and a **harmonic
 * mean** (which punishes low outliers). Both pull an inflated arithmetic mean
 * down toward what Chess.com / Lichess report.
 *
 * @param winPctWhiteSeq White win% at each position, length = moves.length + 1
 *   (index 0 is before the first move).
 * @param moves per-move color + accuracy, in play order.
 */
export function gameAccuracies(
  winPctWhiteSeq: number[],
  moves: MoveScore[],
): { white: number; black: number } {
  const n = moves.length;
  if (n === 0) return { white: 100, black: 100 };

  const windowSize = clamp(Math.ceil(n / 10), 2, 8);
  const weights = moves.map((_, i) => {
    const end = i + 2; // include the position resulting from this move
    const start = Math.max(0, end - windowSize);
    return clamp(stdev(winPctWhiteSeq.slice(start, end)), 0.5, 12);
  });

  const forColor = (color: Color): number => {
    const idxs = moves.map((m, i) => (m.color === color ? i : -1)).filter((i) => i >= 0);
    if (idxs.length === 0) return 100;
    const accs = idxs.map((i) => moves[i].accuracy);
    const ws = idxs.map((i) => weights[i]);
    const weightedMean =
      accs.reduce((a, acc, j) => a + acc * ws[j], 0) / ws.reduce((a, b) => a + b, 0);
    const harmonicMean = accs.length / accs.reduce((a, acc) => a + 1 / Math.max(acc, 1), 0);
    return (weightedMean + harmonicMean) / 2;
  };

  return { white: forColor('white'), black: forColor('black') };
}
