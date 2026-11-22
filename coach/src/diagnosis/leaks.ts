import type { Outcome, TimeClass } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { LEAK_CFG } from '../config';
import { gamePlies, nonPawnMaterial, type PlyFact } from './areas';
import { mulberry32 } from './stats';

/**
 * "Where your points go", from the player's own games only. Each of the player's moves gets
 * one situation, checked in this fixed order: low on the clock → already winning → already
 * losing → first 10 moves → endgame → balanced middlegame. What a move "gives away" is the
 * drop in the mover's winning chances (win % before − after, never negative), in whole-game
 * units (100 win-% points = 1).
 */
export type LeakKey = 'clock' | 'winning' | 'losing' | 'opening' | 'endgame' | 'middlegame';
/** The situations in the order they are checked. */
export const LEAK_KEYS: LeakKey[] = ['clock', 'winning', 'losing', 'opening', 'endgame', 'middlegame'];

export const LEAK_LABELS: Record<LeakKey, string> = {
  clock: 'Low on the clock',
  winning: "When you're already winning",
  losing: "When you're already losing",
  opening: `Your first ${LEAK_CFG.openingLastMove} moves`,
  endgame: 'Endgames',
  middlegame: 'Balanced middlegames',
};

export interface Leak {
  key: LeakKey;
  label: string;
  /** Share of everything the player gave away that was given away in this situation, %. */
  sharePct: number;
  /** 95% range of that share, from resampling whole games. */
  shareRange: [number, number];
  /** The player's mistakes and blunders in this situation, per game. */
  bigMistakesPerGame: number;
  /** Winning chances the player gave away here per 10 games, in whole games (1 = a full game). */
  givenAwayPer10: number;
  /** The same for the opponents, in the same games and the same situation (their point of view). */
  oppGivenAwayPer10: number;
  /** The player's moves in this situation. */
  moves: number;
}

export interface Conversion {
  /** Games where the player was clearly winning: win % ≥ winningWinPct before winningConsecutive own moves in a row. */
  winningGames: number;
  won: number;
  drawn: number;
  lost: number;
  convertedPct: number;
  /** Lost-from-winning games as a share of all the player's losses, %. */
  lostShareOfLossesPct: number;
  lostShareRange: [number, number];
  /** The same for the opponents: games where they were clearly winning, and how many they won. */
  oppWinningGames: number;
  oppConvertedPct: number;
}

export interface TimeLosses {
  losses: number;
  /** Losses whose PGN Termination says "on time". */
  onTime: number;
  sharePct: number;
}

export interface WhatIf {
  label: string;
  extraScorePerGame: number;
  /** Rough rating change, rounded to 5. */
  ratingPoints: number;
}

export type LeakFocus = { kind: 'keepTheWin' } | { kind: 'clock' } | { kind: 'leak'; key: LeakKey };

export interface LeakReport {
  usernames: string[];
  /** Most common time class among the games ('blitz' when there are none; mixing is noted). */
  timeClass: TimeClass;
  games: number;
  /** Unix seconds of the newest game included; 0 when there are none. */
  asOf: number;
  /** Average result per game: win 1, draw ½, loss 0. */
  avgScore: number;
  /** All six situations, largest share first. */
  leaks: Leak[];
  conversion: Conversion;
  timeLosses: TimeLosses;
  whatIf: WhatIf | null;
  focus: LeakFocus;
  notes: string[];
}

export interface KeepTheWinCandidate {
  gameId: string;
  ply: number;
  outcome: Outcome;
  endTime: number;
  /** Win-% points lost by the move in the quick (bulk) analysis. */
  quickLossPts: number;
}

/** The situation a move falls in (see LeakKey for the order). Clock needs a reading and a timed game. */
export function leakCategory(
  fenBefore: string,
  ply: number,
  winBeforeMover: number,
  clockBeforeSec: number | null,
  baseSec: number,
): LeakKey {
  const clockLimit = Math.max(LEAK_CFG.clockSec, LEAK_CFG.clockFrac * baseSec);
  if (clockBeforeSec !== null && baseSec > 0 && clockBeforeSec < clockLimit) return 'clock';
  if (winBeforeMover >= LEAK_CFG.winningWinPct) return 'winning';
  if (winBeforeMover <= LEAK_CFG.losingWinPct) return 'losing';
  if (Math.floor(ply / 2) + 1 <= LEAK_CFG.openingLastMove) return 'opening';
  if (nonPawnMaterial(fenBefore) <= LEAK_CFG.endgameMaxNonPawn) return 'endgame';
  return 'middlegame';
}

/** Rating points for a gain in score per game at the current score: the logistic Elo slope. */
export function eloForScoreGain(dScorePerGame: number, currentScore: number): number {
  const p = Math.min(0.95, Math.max(0.05, currentScore));
  return ((400 / Math.LN10) * dScorePerGame) / (p * (1 - p));
}

/** Focus rule, fixed in advance: keep the win → the clock → the biggest situation other than "already losing". */
export function chooseLeakFocus(conversion: Conversion, timeLosses: TimeLosses, leaks: Leak[]): LeakFocus {
  if (
    conversion.winningGames >= LEAK_CFG.focusMinWinningGames &&
    conversion.lostShareOfLossesPct >= LEAK_CFG.focusKeepTheWinLostSharePct
  ) {
    return { kind: 'keepTheWin' };
  }
  if (timeLosses.losses >= LEAK_CFG.focusClockMinLosses && timeLosses.sharePct >= LEAK_CFG.focusClockSharePct) {
    return { kind: 'clock' };
  }
  const top = rankLeaks(leaks.filter((l) => l.key !== 'losing'))[0];
  return { kind: 'leak', key: top?.key ?? 'middlegame' };
}

function rankLeaks(leaks: Leak[]): Leak[] {
  return [...leaks].sort((a, b) => b.sharePct - a.sharePct || LEAK_KEYS.indexOf(a.key) - LEAK_KEYS.indexOf(b.key));
}

/** One game boiled down to what the report needs. */
interface GameLeaks {
  myLoss: number[]; // given away per situation, whole-game units
  oppLoss: number[];
  myBig: number[];
  myMoves: number[];
  iWasWinning: boolean;
  theyWereWinning: boolean;
  outcome: Outcome;
  onTime: boolean;
  endTime: number;
  noClock: boolean;
}

const memo = new WeakMap<CachedGame, GameLeaks | null>();

/** The mover's clock before ply i: their clock after their previous move, or the base time for a first move. */
function clockBefore(c: CachedGame, ply: number): number | null {
  const { baseSec, clocks } = c.game;
  if (baseSec <= 0) return null;
  return ply < 2 ? baseSec : (clocks[ply - 2] ?? null);
}

function summarise(c: CachedGame): GameLeaks | null {
  if (memo.has(c)) return memo.get(c)!;
  const plies = gamePlies(c);
  let out: GameLeaks | null = null;
  if (plies) {
    const zero = () => LEAK_KEYS.map(() => 0);
    const g: GameLeaks = {
      myLoss: zero(), oppLoss: zero(), myBig: zero(), myMoves: zero(),
      iWasWinning: false, theyWereWinning: false,
      outcome: c.game.outcome,
      onTime: c.game.outcome === 'loss' && /\[Termination "[^"]*on time[^"]*"\]/i.test(c.game.pgn),
      endTime: c.game.endTime,
      noClock: c.game.baseSec <= 0 || c.game.clocks.every((s) => s === null),
    };
    let myRun = 0;
    let oppRun = 0;
    for (const p of plies) {
      const k = LEAK_KEYS.indexOf(leakCategory(p.fenBefore, p.ply, p.winBeforeMover, clockBefore(c, p.ply), c.game.baseSec));
      const winningNow = p.winBeforeMover >= LEAK_CFG.winningWinPct;
      if (p.mine) {
        g.myLoss[k] += p.lossPts / 100;
        g.myMoves[k]++;
        if (p.mistake) g.myBig[k]++;
        myRun = winningNow ? myRun + 1 : 0;
        if (myRun >= LEAK_CFG.winningConsecutive) g.iWasWinning = true;
      } else {
        g.oppLoss[k] += p.lossPts / 100;
        oppRun = winningNow ? oppRun + 1 : 0;
        if (oppRun >= LEAK_CFG.winningConsecutive) g.theyWereWinning = true;
      }
    }
    out = g;
  }
  memo.set(c, out);
  return out;
}

function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function range95(draws: Float64Array, k: number, fallback: number): [number, number] {
  if (k === 0) return [fallback, fallback];
  const s = draws.subarray(0, k).sort();
  return [quantile(s, 0.025), quantile(s, 0.975)];
}

/**
 * 95% ranges for each situation's share and for lost-from-winning's share of losses, from
 * resampling whole games with replacement (seeded). One pass serves all of them.
 */
function bootstrapShares(gs: GameLeaks[], shares: number[], lostShare: number): { share: [number, number][]; lost: [number, number] } {
  const n = LEAK_CFG.bootstrapN;
  const m = gs.length;
  const K = LEAK_KEYS.length;
  const draws = LEAK_KEYS.map(() => new Float64Array(n));
  const lostDraws = new Float64Array(n);
  let kShare = 0;
  let kLost = 0;
  if (m > 0) {
    const rand = mulberry32(LEAK_CFG.seed);
    const sums = new Float64Array(K);
    for (let b = 0; b < n; b++) {
      sums.fill(0);
      let total = 0, losses = 0, lostWin = 0;
      for (let j = 0; j < m; j++) {
        const g = gs[(rand() * m) | 0];
        for (let c = 0; c < K; c++) sums[c] += g.myLoss[c];
        if (g.outcome === 'loss') {
          losses++;
          if (g.iWasWinning) lostWin++;
        }
      }
      for (let c = 0; c < K; c++) total += sums[c];
      if (total > 0) {
        for (let c = 0; c < K; c++) draws[c][kShare] = (100 * sums[c]) / total;
        kShare++;
      }
      if (losses > 0) lostDraws[kLost++] = (100 * lostWin) / losses;
    }
  }
  return {
    share: draws.map((d, c) => range95(d, kShare, shares[c])),
    lost: range95(lostDraws, kLost, lostShare),
  };
}

function ownGames(games: CachedGame[], usernames: string[]): CachedGame[] {
  const named = new Set(usernames.map((u) => u.toLowerCase()));
  return games.filter((c) => named.has(c.game.username.toLowerCase()));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const SCORE: Record<Outcome, number> = { win: 1, draw: 0.5, loss: 0 };

/**
 * Where the player's points go, from their own analysed games: situations ranked by the
 * share of winning chances given away, how often clearly winning games were converted,
 * losses on time, one rough what-if, and the focus by the fixed rule. Only games of the
 * named accounts are used (matched ignoring case).
 */
export function leakReport(games: CachedGame[], usernames: string[]): LeakReport {
  const own = ownGames(games, usernames);
  const pairs = own.map((c) => [c, summarise(c)] as const).filter((p): p is readonly [CachedGame, GameLeaks] => p[1] !== null);
  const usable = pairs.map((p) => p[0]);
  const gs = pairs.map((p) => p[1]);
  const n = gs.length;
  const K = LEAK_KEYS.length;

  const my = new Array<number>(K).fill(0);
  const opp = new Array<number>(K).fill(0);
  const big = new Array<number>(K).fill(0);
  const moves = new Array<number>(K).fill(0);
  let winningGames = 0, won = 0, drawn = 0, lost = 0, oppWinningGames = 0, oppWon = 0;
  let losses = 0, onTime = 0, score = 0, noClock = 0;
  for (const g of gs) {
    for (let c = 0; c < K; c++) {
      my[c] += g.myLoss[c];
      opp[c] += g.oppLoss[c];
      big[c] += g.myBig[c];
      moves[c] += g.myMoves[c];
    }
    score += SCORE[g.outcome];
    if (g.outcome === 'loss') losses++;
    if (g.onTime) onTime++;
    if (g.noClock) noClock++;
    if (g.iWasWinning) {
      winningGames++;
      if (g.outcome === 'win') won++;
      else if (g.outcome === 'draw') drawn++;
      else lost++;
    }
    if (g.theyWereWinning) {
      oppWinningGames++;
      if (g.outcome === 'loss') oppWon++;
    }
  }
  const total = my.reduce((s, x) => s + x, 0);
  const shares = my.map((x) => (total > 0 ? (100 * x) / total : 0));
  const lostShareOfLossesPct = losses > 0 ? (100 * lost) / losses : 0;
  const ranges = bootstrapShares(gs, shares, lostShareOfLossesPct);
  const per = (x: number) => (n > 0 ? x / n : 0);

  const leaks = rankLeaks(
    LEAK_KEYS.map((key, c) => ({
      key,
      label: LEAK_LABELS[key],
      sharePct: shares[c],
      shareRange: ranges.share[c],
      bigMistakesPerGame: per(big[c]),
      givenAwayPer10: 10 * per(my[c]),
      oppGivenAwayPer10: 10 * per(opp[c]),
      moves: moves[c],
    })),
  );
  const conversion: Conversion = {
    winningGames,
    won,
    drawn,
    lost,
    convertedPct: winningGames > 0 ? (100 * won) / winningGames : 0,
    lostShareOfLossesPct,
    lostShareRange: ranges.lost,
    oppWinningGames,
    oppConvertedPct: oppWinningGames > 0 ? (100 * oppWon) / oppWinningGames : 0,
  };
  const timeLosses: TimeLosses = { losses, onTime, sharePct: losses > 0 ? (100 * onTime) / losses : 0 };
  const avgScore = per(score);
  // Half of the lost-from-winning games turned into wins: each one is +1 point.
  const extraScorePerGame = per(lost / 2);
  const whatIf: WhatIf | null =
    lost > 0
      ? {
          label: 'If you lost half as many games you were winning',
          extraScorePerGame,
          ratingPoints: Math.round(eloForScoreGain(extraScorePerGame, avgScore) / 5) * 5,
        }
      : null;
  const focus = chooseLeakFocus(conversion, timeLosses, leaks);

  const notes: string[] = [];
  const otherAccounts = games.length - own.length;
  const skipped = own.length - n;
  if (n === 0) notes.push("No analysed games yet, so there's nothing to report.");
  else {
    notes.push(
      `Based on ${plural(n, 'game')} of yours. "Given away" is how much your winning chances dropped ` +
        "with each of your moves, by the engine's quick check, added up by situation. Each share has a " +
        'range from re-drawing whole games at random.',
    );
    notes.push(
      `Clearly winning means your winning chances were at least ${LEAK_CFG.winningWinPct}% before ` +
        `${LEAK_CFG.winningConsecutive} of your moves in a row.`,
    );
  }
  if (otherAccounts > 0) {
    notes.push(`${plural(otherAccounts, 'game')} from other accounts ${otherAccounts === 1 ? 'was' : 'were'} left out.`);
  }
  if (skipped > 0) {
    notes.push(`${plural(skipped, 'game')} could not be replayed and ${skipped === 1 ? 'was' : 'were'} left out.`);
  }
  if (noClock > 0) notes.push(`"Low on the clock" needs clock times; ${noClock} of ${n} games had none.`);
  const { main: timeClass, all: timeClasses } = mostCommonTimeClass(usable.length ? usable : own);
  if (timeClasses.length > 1) notes.push(`These games mix time classes (${timeClasses.join(', ')}); they are counted together.`);
  if (n > 0 && winningGames < LEAK_CFG.focusMinWinningGames) {
    notes.push(
      `Only ${plural(winningGames, 'game')} where you were clearly winning; at least ` +
        `${LEAK_CFG.focusMinWinningGames} are needed before converting them can be the focus.`,
    );
  }
  if (oppWinningGames > 0 && winningGames > 0) {
    notes.push(
      `For context: when your opponents were clearly winning, they won ${Math.round(conversion.oppConvertedPct)}% ` +
        `of those games; you won ${Math.round(conversion.convertedPct)}% of yours.`,
    );
  }
  if (whatIf) {
    notes.push(
      'The rating figure is a rough estimate from results alone: it assumes half of the winning ' +
        'games you lost had been won, and uses the usual rating formula at your current score.',
    );
  }

  return {
    usernames: [...usernames],
    timeClass,
    games: n,
    asOf: gs.reduce((m, g) => Math.max(m, g.endTime), 0),
    avgScore,
    leaks,
    conversion,
    timeLosses,
    whatIf,
    focus,
    notes,
  };
}

function mostCommonTimeClass(games: CachedGame[]): { main: TimeClass; all: TimeClass[] } {
  const counts = new Map<TimeClass, number>();
  for (const c of games) counts.set(c.game.timeClass, (counts.get(c.game.timeClass) ?? 0) + 1);
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'blitz';
  return { main, all: [...counts.keys()] };
}

/**
 * Positions for "keep the win": the player's moves made while already winning (win % before
 * ≥ winningWinPct) that the quick analysis classed as a mistake or blunder. Games the player
 * went on to lose come first, then draws, then wins; newest first within each; then by move.
 */
export function keepTheWinCandidates(games: CachedGame[], usernames: string[]): KeepTheWinCandidate[] {
  const out: KeepTheWinCandidate[] = [];
  for (const c of ownGames(games, usernames)) {
    const plies: PlyFact[] | null = gamePlies(c);
    if (!plies) continue;
    for (const p of plies) {
      if (p.mine && p.mistake && p.winBeforeMover >= LEAK_CFG.winningWinPct) {
        out.push({ gameId: c.game.id, ply: p.ply, outcome: c.game.outcome, endTime: c.game.endTime, quickLossPts: p.lossPts });
      }
    }
  }
  const rank: Record<Outcome, number> = { loss: 0, draw: 1, win: 2 };
  return out.sort(
    (a, b) =>
      rank[a.outcome] - rank[b.outcome] || b.endTime - a.endTime || a.gameId.localeCompare(b.gameId) || a.ply - b.ply,
  );
}
