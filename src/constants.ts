/** Bump when the cached AnalysisResult shape or scoring changes (invalidates old caches). */
export const SCHEMA_VERSION = 3;

/** Engine search budget per position. */
export const ENGINE = {
  movetimeMs: 400,
  multiPV: 1,
};

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
