/** Bump when the cached AnalysisResult shape or scoring changes (invalidates old caches). */
export const SCHEMA_VERSION = 7;

/**
 * Nudge a raw (Lichess-style) accuracy toward Chess.com's CAPS2 band.
 * `100 * (raw/100)^GAMMA`: identity at 0 and 100, compressive in between.
 *
 * GAMMA is fit to 12 paired samples — real Chess.com blitz games (Hikaru's
 * Oct/Nov 2026 games, whose Chess.com accuracies are in the public API),
 * re-analyzed with Stockfish and compared against Chess.com's own numbers.
 * Least-squares fit on log-log scale: 1.124, rounded to 1.1. With it, the
 * mean error vs Chess.com is +0.4 points (MAE 3.4); the previous value of
 * 1.7 — fit to a single game — averaged -5.5 points (MAE 6.1, worst -15.8).
 *
 * Re-fit Nov 16, 2026 after the checkmate fix (terminal positions are no
 * longer scored via the engine's mate-0 eval): least-squares on the same 12
 * samples gives 1.150 (bias +0.1, MAE 3.9). Kept at 1.1 — the sample's
 * decisive games all ended by resignation, so the original fit was never
 * contaminated by the bug; the 1.124 → 1.150 shift is run-to-run engine
 * variance, and 1.1 has the lower MAE on the new run (3.7 vs 3.9). If a
 * future sample includes mate endings, re-fit and prefer the new value.
 *
 * Limits, stated plainly: the raw Lichess score already tracks Chess.com
 * within ~±3 MAE, and the residual scatter (SD ~4.3) is irreducible from
 * here — CAPS2 is proprietary, rating-adjusted, and run on deeper server
 * analysis. This fit is also GM-blitz-specific; club-player games may sit
 * slightly differently. Re-fit if a better paired sample comes along:
 * collect (raw, chess.com) pairs, then gamma = Σ ln(r/100)·ln(c/100) /
 * Σ ln(r/100)². Keep gamma near 1 — the formula is close; the calibration
 * is a nudge, not a correction.
 */
export const ACCURACY_CALIBRATION_GAMMA = 1.1;

/**
 * Engine search budget per position. At fixed total wall-time, searches are
 * halved by replaying each position's after-eval as the next ply's before-eval
 * (see analyzeGame), so movetime can be much deeper than it looks. MultiPV 2
 * exposes the engine's second-best line, which powers Great-move detection.
 */
export const ENGINE = {
  movetimeMs: 900,
  multiPV: 2,
};

/**
 * A played move counts as Chess.com-style "Great" when it is the engine's best
 * move AND the second-best alternative is at least this many win% worse
 * (mover's POV) — i.e. there was effectively only one good move.
 */
export const GREAT_MOVE = { minWinPctGap: 5 };

/**
 * Win-probability lost (in percentage points, mover POV) that separates each
 * classification band. A move losing < good is "best", < inaccuracy is "good",
 * and so on; anything at/above blunder is a "blunder".
 */
export const DELTA = {
  good: 2,
  inaccuracy: 5,
  mistake: 10,
  blunder: 20,
};

/**
 * A move is a "missed win" if the engine's best move would have left the mover
 * clearly winning and the played move left the game roughly equal or worse
 * (Chess.com's definition: miss the chance to capitalize and gain a winning
 * position, and end up equal or worse instead).
 */
export const MISSED_WIN = {
  winningWinPct: 75,
  dropTo: 60,
};

/**
 * A move is a Chess.com-style "Miss" (missed opportunity) if the best move
 * would have gained a clear edge and the played move left the game level or
 * worse — without the position already being won (that case is a missed win).
 * This is the "opponent blundered and you didn't punish it" case: the played
 * move need not lose anything itself, it just fails to seize the advantage.
 */
export const MISS = {
  /** Win% the best move would have reached (a clear edge, not yet a win). */
  gainWinPct: 65,
  /** Win% the played move left the mover at or below (level or worse). */
  dropTo: 55,
  /** Minimum win% swing between the best and played move. */
  minSwing: 15,
};

/** How many moves of the engine's best line to store per ply (for the line explorer). */
export const BEST_LINE_MAX_MOVES = 12;

/** Logistic steepness for centipawn -> win% conversion (Lichess-style). */
export const WINPCT_K = 0.00368208;

/** How many recent games to show in the list. */
export const RECENT_GAME_COUNT = 20;

/** User-facing copy kept in one place. */
export const COPY = {
  appName: 'Postgame',
  fetching: 'Fetching your latest games…',
  upToDate: "You're up to date",
};
