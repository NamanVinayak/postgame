import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Engine settings for bulk analysis of many games (fast, shallow).
// 30 ms ≈ depth 11–12 on an M4 Pro with MultiPV 2; enough to compare error rates fairly,
// since both sides are graded the same way; displayed positions use DISPLAY_CFG.
export const ENGINE_CFG = { movetimeMs: 30, threads: 2, hashMb: 64, multiPv: 2 };
// How many recent games to pull, and how close in rating an opponent must be to count.
export const SOURCE_CFG = { defaultMaxGames: 300, ratingWindow: 200 };
// Definitions of the six game areas a move can be filed under.
export const AREA_CFG = {
  openingLastMove: 10,          // mover's move number ≤ 10 → opening
  endgameMaxNonPawn: 26,        // both sides' Q9 R5 B3 N3 total ≤ 26 → endgame
  convertingMinWin: 75,         // mover's win% before move ≥ 75
  defendingMaxWin: 25,          // mover's win% before move ≤ 25
  timePressureSec: 30,          // clock before move < max(30 s, 10% of base)
  timePressureFrac: 0.10,
};
// Sample-size floors and significance settings for calling an area a weakness.
export const STATS_CFG = {
  minGames: 30, minMoves: 150,
  meaningfulGapPts: 2.0,   // power check (see plan B4): with ~300 games the 95% half-width is ~1.5 pts per area,
                           // so 1.0 would almost never allow "not your problem"; 2 pts ≈ one extra serious mistake per 50 moves
  gapAlpha: 0.05 / 6,      // six areas tested at once → Bonferroni-adjusted interval for the "gap" label
  minErrors: 20,           // both sides' serious mistakes combined; with fewer, resampled ranges look far surer
                           // than they are (e.g. 7 vs 0 over 150 moves clears zero), so the area is not judged
  bootstrapN: 10000,       // resamples per area; the adjusted range reads the 0.2% tails, which need this many
  seed: 1804,
};
// "Where your points go": the player's own games only. Each of the player's moves gets one
// situation, checked in this order: low on the clock → already winning → already losing →
// first moves → endgame → balanced middlegame.
export const LEAK_CFG = {
  winningWinPct: 75,             // "already winning": your win % before the move ≥ 75
  winningConsecutive: 2,         // a game counts as "clearly winning" after this many own moves in a row at ≥ 75
  losingWinPct: 25,              // "already losing": your win % before the move ≤ 25
  clockSec: 30, clockFrac: 0.1,  // low on the clock: clock before the move < max(30 s, 10% of the base time)
  openingLastMove: 10,           // "your first 10 moves"
  endgameMaxNonPawn: 26,         // endgame: both sides' Q9 R5 B3 N3 total ≤ 26 before the move
  bootstrapN: 4000, seed: 1804,  // ranges from resampling whole games
  focusMinWinningGames: 30,      // focus "keep the win" needs this many clearly-winning games…
  focusKeepTheWinLostSharePct: 20, // …and lost-from-winning ≥ this share of all losses
  focusClockMinLosses: 30,       // focus "the clock" needs this many losses…
  focusClockSharePct: 15,        // …and losses on time ≥ this share of them
  drillsPerWeek: 20,             // weekly practice target for the focus
};
export const DISPLAY_CFG = { movetimeMs: 1500, multiPv: 3 };   // deep search for anything shown or drilled
// When a repeated position counts as a real recurring mistake.
export const REPEAT_CFG = { minSeen: 3, minWrong: 2, wrongLossPts: 5, minAvgLossPts: 6 };
// How many new games must arrive before a past diagnosis is re-checked.
export const RECHECK_CFG = { minNewGames: 30 };
// Public web app that review links and drills point to.
export const POSTGAME_URL = 'https://namanvinayak.github.io/postgame/';

/** Folder holding the coach's cache, snapshots, packs and local config. */
export function coachHome(): string {
  return process.env.POSTGAME_COACH_HOME ?? join(homedir(), '.postgame-coach');
}

export interface LocalConfig {
  excludeAccounts: string[];
  stockfishPath: string;
}

/** Reads `<coachHome>/config.json` if present; missing file or fields fall back to defaults. */
export function loadLocalConfig(): LocalConfig {
  const defaults: LocalConfig = {
    excludeAccounts: [],
    stockfishPath: process.env.STOCKFISH_PATH ?? '/opt/homebrew/bin/stockfish',
  };
  const file = join(coachHome(), 'config.json');
  if (!existsSync(file)) return defaults;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LocalConfig>;
  return {
    excludeAccounts: Array.isArray(raw.excludeAccounts)
      ? raw.excludeAccounts.filter((a): a is string => typeof a === 'string')
      : defaults.excludeAccounts,
    stockfishPath: typeof raw.stockfishPath === 'string' ? raw.stockfishPath : defaults.stockfishPath,
  };
}

/** Creates the coach home and its `cache/`, `snapshots/` and `packs/` subfolders. */
export function ensureDirs(): void {
  for (const sub of ['cache', 'snapshots', 'packs']) {
    mkdirSync(join(coachHome(), sub), { recursive: true });
  }
}
