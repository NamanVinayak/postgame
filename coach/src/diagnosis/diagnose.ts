import type { TimeClass } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { STATS_CFG } from '../config';
import { AREA_KEYS, AREA_NAMES, gamePlies, type AreaKey } from './areas';
import { findRepeated, type RepeatedPosition } from './repeated';
import { bootstrapGap, type GameCounts } from './stats';

/**
 * How an area is labelled. The rules were fixed before looking at any real games:
 * - notEnoughData: either side has moves from fewer than STATS_CFG.minGames games, or fewer
 *   than minMoves moves, in the area.
 * - gap: the adjusted range (two-sided, 1 − gapAlpha, allowing for six areas at once) lies
 *   entirely above 0.
 * - notYourProblem: the 95% range's upper end is below meaningfulGapPts.
 * - noClearDifference: enough data, but the range is too wide to call either way.
 */
export type AreaLabel = 'gap' | 'notYourProblem' | 'noClearDifference' | 'notEnoughData';

export interface AreaFinding {
  area: AreaKey;
  label: AreaLabel;
  /** % of moves in the area that were a mistake or blunder (0 when a side has no moves). */
  myRate: number;
  oppRate: number;
  /** my − opponent, percentage points. */
  gapPts: number;
  ci95: [number, number];
  ciAdj: [number, number];
  /** Games with any move in this area, by either side. */
  games: number;
  /** Games in which the player / the comparison side made at least one move in this area. */
  myGames: number;
  oppGames: number;
  myMoves: number;
  oppMoves: number;
  /** Plain-English notes for this row; the first is always "same games, resampled by game". */
  notes: string[];
}

export interface Diagnosis {
  usernames: string[];
  /** Most common time class among the games ('blitz' when there are none; mixing is noted). */
  timeClass: TimeClass;
  /** Games the diagnosis rests on (games that could not be replayed are left out). */
  games: number;
  /** Unix seconds of the newest game included; 0 when there are none. */
  asOf: number;
  areas: AreaFinding[];
  repeated: RepeatedPosition[];
  focus: { kind: 'area'; area: AreaKey } | { kind: 'repeated'; keys: string[] } | null;
  /** Plain-English notes a player should read alongside the table. */
  notes: string[];
}

/**
 * Swap point: what the player's error rate is compared against. Another implementation
 * could return expected errors for players at this rating from a larger population.
 */
export interface Baseline {
  /** Shown in the notes, e.g. "your opponents in the same games". */
  name: string;
  perGame(c: CachedGame, area: AreaKey): { oppErr: number; oppN: number };
}

const countsMemo = new WeakMap<CachedGame, Record<AreaKey, GameCounts> | null>();

/**
 * Serious mistakes and moves per area in one game, for the player and for the opponent in
 * that same game; null when the game can't be replayed. Remembered per game object.
 */
export function gameAreaCounts(c: CachedGame): Record<AreaKey, GameCounts> | null {
  if (countsMemo.has(c)) return countsMemo.get(c)!;
  const plies = gamePlies(c);
  let out: Record<AreaKey, GameCounts> | null = null;
  if (plies) {
    out = Object.fromEntries(AREA_KEYS.map((a) => [a, { myErr: 0, myN: 0, oppErr: 0, oppN: 0 }])) as Record<
      AreaKey,
      GameCounts
    >;
    for (const p of plies) {
      for (const a of p.areas) {
        const t = out[a];
        if (p.mine) {
          t.myN++;
          if (p.mistake) t.myErr++;
        } else {
          t.oppN++;
          if (p.mistake) t.oppErr++;
        }
      }
    }
  }
  countsMemo.set(c, out);
  return out;
}

/** Default baseline: the opponent's own moves in the same game. */
export const sameGameOpponents: Baseline = {
  name: 'your opponents in the same games',
  perGame(c, area) {
    const t = gameAreaCounts(c)?.[area];
    return { oppErr: t?.oppErr ?? 0, oppN: t?.oppN ?? 0 };
  },
};

/**
 * One row per replayable game that has any move in the area: the player's counts plus the
 * baseline's. These are the units the ranges resample (also used by the re-check).
 */
export function areaRows(games: CachedGame[], area: AreaKey, baseline: Baseline = sameGameOpponents): GameCounts[] {
  const rows: GameCounts[] = [];
  for (const c of games) {
    const mine = gameAreaCounts(c)?.[area];
    if (!mine) continue;
    const opp = baseline.perGame(c, area);
    if (mine.myN + opp.oppN === 0) continue;
    rows.push({ myErr: mine.myErr, myN: mine.myN, oppErr: opp.oppErr, oppN: opp.oppN });
  }
  return rows;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const pts = (x: number): string => x.toFixed(1);

/** Why an area can't be judged yet, one note per side that falls short. */
function shortfalls(who: 'your' | 'opponent', moves: number, games: number): string[] {
  const { minGames, minMoves } = STATS_CFG;
  const whose = who === 'your' ? 'your moves' : "your opponents' moves";
  if (moves === 0) return [who === 'your' ? 'none of your moves fall here' : 'no opponent moves fall here'];
  const out: string[] = [];
  if (games < minGames) out.push(`${whose} here come from only ${plural(games, 'game')}; ${minGames} needed`);
  if (moves < minMoves) out.push(`only ${moves} of ${whose} fall here; ${minMoves} needed`);
  return out;
}

/** The finding for one area from its per-game rows. */
export function areaFinding(area: AreaKey, rows: GameCounts[]): AreaFinding {
  let myErr = 0, myN = 0, oppErr = 0, oppN = 0, myGames = 0, oppGames = 0;
  for (const r of rows) {
    myErr += r.myErr; myN += r.myN; oppErr += r.oppErr; oppN += r.oppN;
    if (r.myN > 0) myGames++;
    if (r.oppN > 0) oppGames++;
  }
  const { gap, ci95, ciAdj } = bootstrapGap(rows, STATS_CFG.bootstrapN, STATS_CFG.seed);
  const short = [...shortfalls('your', myN, myGames), ...shortfalls('opponent', oppN, oppGames)];
  const label: AreaLabel =
    short.length > 0
      ? 'notEnoughData'
      : ciAdj[0] > 0
        ? 'gap'
        : ci95[1] < STATS_CFG.meaningfulGapPts
          ? 'notYourProblem'
          : 'noClearDifference';
  return {
    area,
    label,
    myRate: myN > 0 ? (100 * myErr) / myN : 0,
    oppRate: oppN > 0 ? (100 * oppErr) / oppN : 0,
    gapPts: gap,
    ci95,
    ciAdj,
    games: rows.length,
    myGames,
    oppGames,
    myMoves: myN,
    oppMoves: oppN,
    notes: ['same games, resampled by game', ...short],
  };
}

function summary(a: AreaFinding, against: string): string {
  return (
    `${AREA_NAMES[a.area]}, where ${pts(a.myRate)}% of your moves were serious mistakes against ` +
    `${pts(a.oppRate)}% for ${against} (gap ${pts(a.gapPts)} points, range ${pts(a.ci95[0])} to ` +
    `${pts(a.ci95[1])}, ${plural(a.games, 'game')})`
  );
}

function mostCommonTimeClass(games: CachedGame[]): { main: TimeClass; all: TimeClass[] } {
  const counts = new Map<TimeClass, number>();
  for (const c of games) counts.set(c.game.timeClass, (counts.get(c.game.timeClass) ?? 0) + 1);
  const all = [...counts.keys()];
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'blitz';
  return { main, all };
}

/**
 * The honest diagnosis: for each of the six areas, the player's serious-mistake rate against
 * the baseline's (by default, their opponents in the same games), with a range from
 * resampling whole games and a label fixed in advance; plus positions the player keeps
 * getting wrong. The focus is the clearest gap, else the top repeated positions, else none.
 */
export function diagnose(games: CachedGame[], usernames: string[], baseline: Baseline = sameGameOpponents): Diagnosis {
  const usable = games.filter((c) => gameAreaCounts(c) !== null);
  const skipped = games.length - usable.length;
  const n = usable.length;
  const areas = AREA_KEYS.map((a) => areaFinding(a, areaRows(usable, a, baseline)));
  const repeated = findRepeated(usable);
  const gaps = areas.filter((a) => a.label === 'gap').sort((a, b) => b.ciAdj[0] - a.ciAdj[0]);
  const focus: Diagnosis['focus'] =
    gaps.length > 0
      ? { kind: 'area', area: gaps[0].area }
      : repeated.length > 0
        ? { kind: 'repeated', keys: repeated.slice(0, 3).map((r) => r.key) }
        : null;
  const { main: timeClass, all: timeClasses } = mostCommonTimeClass(usable.length ? usable : games);

  const notes: string[] = [];
  if (n === 0) {
    notes.push(
      games.length === 0
        ? 'No analysed games yet, so nothing can be judged.'
        : 'None of these games could be read, so nothing can be judged.',
    );
  } else {
    notes.push(`Based on ${plural(n, 'game')}, comparing you with ${baseline.name}.`);
    if (n < STATS_CFG.minGames) {
      notes.push(
        `Only ${plural(n, 'game')} so far: an area needs moves from at least ${STATS_CFG.minGames} games ` +
          'on each side before it can be judged.',
      );
    }
    notes.push(
      'Gaps are in percentage points of moves that were serious mistakes (a mistake or a blunder). ' +
        'Each range shows how far the gap could move with a different set of games like these, ' +
        'counting each game as one unit. An area is only called a gap when a stricter range, which ' +
        `allows for checking ${AREA_KEYS.length} areas at once, stays above zero.`,
    );
  }
  if (skipped > 0) {
    notes.push(
      `${plural(skipped, 'game')} could not be replayed and ${skipped === 1 ? 'was' : 'were'} left out.`,
    );
  }
  const noClock = usable.filter((c) => c.game.baseSec === 0 || c.game.clocks.every((s) => s === null)).length;
  if (noClock > 0) notes.push(`The time-pressure area needs clock times; ${noClock} of ${n} games had none.`);
  if (timeClasses.length > 1) notes.push(`These games mix time classes (${timeClasses.join(', ')}); they are pooled.`);

  if (gaps.length > 0) {
    notes.push(`Clearest gap: ${summary(gaps[0], baseline.name)}.`);
  } else if (n > 0) {
    const judged = areas.filter((a) => a.label !== 'notEnoughData');
    if (judged.length === 0) {
      notes.push('No area has enough games to judge yet.');
    } else {
      notes.push('No area stands out against players at your rating.');
      const largest = judged
        .filter((a) => a.label === 'noClearDifference' && a.gapPts > 0)
        .sort((a, b) => b.gapPts - a.gapPts)[0];
      if (largest) notes.push(`Largest difference (tentative, not proven): ${summary(largest, baseline.name)}.`);
    }
    const k = Math.min(3, repeated.length);
    notes.push(
      k === 0
        ? 'No focus yet: no area shows a clear gap and no position keeps going wrong.'
        : `Focus: the ${k === 1 ? 'position' : `${k} positions`} you keep getting wrong.`,
    );
  }

  return {
    usernames: [...usernames],
    timeClass,
    games: n,
    asOf: usable.reduce((m, c) => Math.max(m, c.game.endTime), 0),
    areas,
    repeated,
    focus,
    notes,
  };
}
