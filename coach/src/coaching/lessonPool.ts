/**
 * This week's lesson positions, by the leak report's focus (spec §6c, "Lesson content by focus"),
 * and the lazy, capped deep check that turns quick-check candidates into positions worth asking.
 *
 * - Keep the win: the player's mistakes and blunders made while already winning
 *   (`keepTheWinCandidates`: games they lost first, then drawn, then won; newest first).
 * - A situation (the clock, or one leak such as "your first 10 moves"): that situation's costly
 *   moves (a drop of 10+ win-% points), each game's biggest first, newest game first; for the
 *   first 10 moves, the positions the player keeps reaching and getting wrong come first.
 *
 * Candidates come from the cached quick analysis only. A position is shown or asked only after a
 * deep check (DISPLAY_CFG) agrees it is worth asking (`teachableAs`). Deep checks are made lazily,
 * in order, within a search budget per call (`SearchBudget`): only searches that actually run
 * count, so results already known (this session, or stored on disk) cost nothing.
 */
import type { Classification } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { LEAK_CFG } from '../config';
import { gamePlies } from '../diagnosis/areas';
import { costlyMoves, keepTheWinCandidates, plyLeakCategory, type LeakFocus, type LeakKey } from '../diagnosis/leaks';
import { positionKey } from '../diagnosis/repeated';
import { KEEP_THE_WIN_PROMPT, PLAIN_PROMPT } from '../server/views';
import { isTeachable, refKey, type Ref } from './lesson';
import type { PositionFacts } from './positionFacts';
import type { SearchBudget } from './searchBudget';
import { firstTries, type StudentFile } from './student';

/**
 * How a lesson candidate is judged at depth (`teachableAs`):
 * - 'keepTheWin': a keep-the-win position;
 * - 'mistake': a costly move of the focus situation;
 * - 'repeated': a position the player keeps reaching and getting wrong.
 */
export type LessonKind = 'keepTheWin' | 'mistake' | 'repeated';

export interface LessonRef extends Ref {
  kind: LessonKind;
  /** The board (position key) before the move. */
  board: string;
}

/** Deep checks per coach_ask_position call, at most (each takes up to two searches of about 1.5 s). */
export const MAX_DEEP_CHECKS = 8;
/** Searches one deep check makes at most (the position before the move, and after it). */
export const SEARCHES_PER_CHECK = 2;
/** Searches one coach_ask_position call may run: MAX_DEEP_CHECKS deep checks. */
export const ASK_SEARCH_BUDGET = MAX_DEEP_CHECKS * SEARCHES_PER_CHECK;
/**
 * Searches one coach_report call may run, for its lesson boards and its quick fixes together
 * (about 1.5 s each, so the call stays well inside a host's tool timeout).
 */
export const REPORT_SEARCH_BUDGET = 20;
/** Lesson boards on the report card. */
export const REPORT_LESSON_BOARDS = 3;
/** "This week" for the drill count: sessions that started in the last 7 days. */
export const DRILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The situation a focus trains, or null for "keep the win". */
export function focusSituation(f: LeakFocus): LeakKey | null {
  if (f.kind === 'keepTheWin') return null;
  return f.kind === 'clock' ? 'clock' : f.key;
}

function boardAt(c: CachedGame, ply: number): string | null {
  const fen = gamePlies(c)?.[ply]?.fenBefore;
  return fen ? positionKey(fen) : null;
}

/** Each game's moves biggest loss first, newest game first; then each game's second biggest, and so on. */
function roundRobinNewest(moves: { c: CachedGame; ply: number; lossPts: number }[]): { c: CachedGame; ply: number }[] {
  const byGame = new Map<string, { c: CachedGame; list: { c: CachedGame; ply: number; lossPts: number }[] }>();
  for (const m of moves) {
    const g = byGame.get(m.c.game.id) ?? { c: m.c, list: [] };
    g.list.push(m);
    byGame.set(m.c.game.id, g);
  }
  const games = [...byGame.values()].sort(
    (a, b) => b.c.game.endTime - a.c.game.endTime || a.c.game.id.localeCompare(b.c.game.id),
  );
  for (const g of games) g.list.sort((a, b) => b.lossPts - a.lossPts || a.ply - b.ply);
  const out: { c: CachedGame; ply: number }[] = [];
  const deepest = Math.max(0, ...games.map((g) => g.list.length));
  for (let rank = 0; rank < deepest; rank++) for (const g of games) if (g.list[rank]) out.push(g.list[rank]);
  return out;
}

/**
 * The focus's candidates in the order to try them, one per board (the first wins). `repeated`
 * is the diagnosis's repeated positions with the sighting to ask (`repeatedRefs`); only "your
 * first 10 moves" uses them, those whose sighting falls in that situation, ahead of the costly
 * moves. Quick check only: every candidate must pass `teachableAs` at depth before it is shown.
 */
export function lessonCandidates(
  focus: LeakFocus,
  games: CachedGame[],
  usernames: string[],
  repeated: { key: string; ref: Ref | null }[] = [],
): LessonRef[] {
  const byId = new Map(games.map((c) => [c.game.id, c]));
  const out: LessonRef[] = [];
  const seen = new Set<string>();
  const add = (c: CachedGame, ply: number, kind: LessonKind) => {
    const board = boardAt(c, ply);
    if (board === null || seen.has(board)) return;
    seen.add(board);
    out.push({ gameId: c.game.id, ply, kind, board });
  };

  const situation = focusSituation(focus);
  if (situation === null) {
    for (const k of keepTheWinCandidates(games, usernames)) {
      const c = byId.get(k.gameId);
      if (c) add(c, k.ply, 'keepTheWin');
    }
    return out;
  }
  if (situation === 'opening') {
    for (const r of repeated) {
      const c = r.ref ? byId.get(r.ref.gameId) : undefined;
      const p = c && r.ref ? gamePlies(c)?.[r.ref.ply] : undefined;
      if (c && p && plyLeakCategory(c, p) === 'opening') add(c, p.ply, 'repeated');
    }
  }
  for (const m of roundRobinNewest(costlyMoves(games, usernames, situation))) add(m.c, m.ply, 'mistake');
  return out;
}

/**
 * Worth asking, judged on the deep check (DISPLAY_CFG):
 * - 'keepTheWin': still winning before the move at depth (win % ≥ LEAK_CFG.winningWinPct), and
 *   the game move is a mistake or blunder against the deep best (the app's thresholds);
 * - 'mistake': the game move is a mistake or blunder against the deep best;
 * - 'repeated': the game move loses more than REPEAT_CFG.wrongLossPts against the deep best
 *   (the line that makes a move wrong in a position the player keeps reaching).
 */
export function teachableAs(kind: LessonKind, quick: Classification, deep: PositionFacts): boolean {
  if (kind === 'repeated') return isTeachable('repeated', quick, deep);
  if (!isTeachable('mistake', quick, deep)) return false;
  return kind === 'mistake' || deep.winBefore >= LEAK_CFG.winningWinPct;
}

/**
 * The line above a board asked by reference (an example, the warm-up): "keeps the win" only when
 * the deep check says the player is winning there.
 */
export function lessonPrompt(deep: PositionFacts): string {
  return deep.winBefore >= LEAK_CFG.winningWinPct ? KEEP_THE_WIN_PROMPT : PLAIN_PROMPT;
}

/**
 * The line above a board from the focus pool: "keeps the win" only for a keep-the-win position
 * (which `teachableAs` already requires to be winning at depth); a board of the clock or a leak
 * always gets the plain line, even when it is winning at depth.
 */
export function poolPrompt(ref: LessonRef): string {
  return ref.kind === 'keepTheWin' ? KEEP_THE_WIN_PROMPT : PLAIN_PROMPT;
}

export interface PoolWalk {
  /** The teachable positions found, in pool order (at most `want`). */
  found: { ref: LessonRef; c: CachedGame; facts: PositionFacts }[];
  /** Deep checks made by this walk (positions not known this session). */
  checks: number;
  /** True when the walk stopped at its search budget with candidates still unchecked. */
  capped: boolean;
}

export interface PoolWalkOptions {
  want: number;
  /** A deep check may start only while this allows SEARCHES_PER_CHECK more searches. */
  budget: SearchBudget;
  load: (gameId: string) => CachedGame | null;
  /** A deep result already known this session (no check at all), or undefined. */
  known: (ref: Ref) => PositionFacts | undefined;
  /** A deep check; only the searches it really runs use the budget. Search failures are thrown. */
  deep: (c: CachedGame, ply: number) => Promise<PositionFacts>;
  /** Positions (refKeys) and boards (position keys) to pass over. */
  exclude?: { refs: Set<string>; boards: Set<string> };
}

/**
 * Walks the pool in order until `want` teachable positions are found (`teachableAs`). A deep
 * check starts only while the budget allows SEARCHES_PER_CHECK more searches; a result `known`
 * already is used without one. Passes over excluded positions and boards, games that aren't
 * cached or can't be replayed, and a board already found.
 */
export async function walkLessonPool(pool: LessonRef[], o: PoolWalkOptions): Promise<PoolWalk> {
  const found: PoolWalk['found'] = [];
  const boards = new Set<string>();
  let checks = 0;
  for (const ref of pool) {
    if (found.length >= o.want) break;
    if (o.exclude?.refs.has(refKey(ref.gameId, ref.ply)) || o.exclude?.boards.has(ref.board) || boards.has(ref.board)) continue;
    const c = o.load(ref.gameId);
    const quick = c?.analysis.plies[ref.ply]?.classification;
    if (!c || !quick || !gamePlies(c)?.[ref.ply]) continue;
    let facts = o.known(ref);
    if (!facts) {
      if (!o.budget.canSpend(SEARCHES_PER_CHECK)) return { found, checks, capped: true };
      checks++;
      facts = await o.deep(c, ref.ply);
    }
    if (teachableAs(ref.kind, quick, facts)) {
      found.push({ ref, c, facts });
      boards.add(ref.board);
    }
  }
  return { found, checks, capped: false };
}

/**
 * This week's drills for the focus: the distinct boards among the first tries of student
 * sessions that started in the last 7 days (DRILL_WINDOW_MS, rolling), counting a try only when
 * its position (game and ply) or its board is in the focus pool. A try begun from an example
 * counts when its board is in the pool. Boards are told apart by the try's key, or `keyOf` for
 * older entries without one.
 */
export function drillsDone(
  student: StudentFile | undefined,
  pool: LessonRef[],
  keyOf: (gameId: string, ply: number) => string | null,
  now: number,
): number {
  if (!student) return 0;
  const refs = new Set(pool.map((r) => refKey(r.gameId, r.ply)));
  const poolBoards = new Set(pool.map((r) => r.board));
  const done = new Set<string>();
  for (const s of student.sessions) {
    if (s.at < now - DRILL_WINDOW_MS) continue;
    for (const t of firstTries(s)) {
      const board = t.key ?? keyOf(t.gameId, t.ply);
      if (board === null) continue;
      if (refs.has(refKey(t.gameId, t.ply)) || poolBoards.has(board)) done.add(board);
    }
  }
  return done.size;
}
