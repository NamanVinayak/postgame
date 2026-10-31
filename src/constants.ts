/** Bump when the cached AnalysisResult shape or scoring changes (invalidates old caches). */
export const SCHEMA_VERSION = 5;

/**
 * Our raw score uses the public Lichess formula, which reads ~10 points higher
 * than Chess.com's proprietary CAPS2 in the 70–90 range. We nudge toward
 * Chess.com by applying `100 * (raw/100)^GAMMA` to the final game accuracy —
 * identity at 0 and 100, compressive in between. GAMMA is fit to observed
 * Chess.com samples (e.g. a game Chess.com scored 73.4 that we scored 83.3 →
 * gamma ≈ 1.7). Refine it as more (our-score, chess.com-score) pairs come in.
 */
export const ACCURACY_CALIBRATION_GAMMA = 1.7;

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

/** A move is a "missed win" if the mover was clearly winning and gave most of it up. */
export const MISSED_WIN = {
  winningWinPct: 75,
  dropTo: 55,
};

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
