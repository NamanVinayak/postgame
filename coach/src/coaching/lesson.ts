/**
 * The "you try first" part of a coaching session (spec §6b, step 4–5): scoring a move the
 * player tried at display depth, and choosing positions of the same pattern to ask.
 *
 * Everything shown or named comes from a deep search (a `DisplayEngine`); the cached quick
 * analysis only proposes candidates. A position is only asked if the deep check agrees that
 * the game move was a real mistake there.
 */
import { Chess, type Move } from 'chess.js';
import { evalToWinPct } from '../../../src/analysis/winPct';
import type { Classification } from '../../../src/types';
import { readCached, type CachedGame } from '../analysis/cache';
import { DISPLAY_CFG, REPEAT_CFG } from '../config';
import { gamePlies, type PlyFact } from '../diagnosis/areas';
import type { Diagnosis } from '../diagnosis/diagnose';
import { positionKey } from '../diagnosis/repeated';
import type { DisplayEngine } from '../engine/displayEngine';
import type { Attempt } from '../server/views';
import { deepDisagrees, deepPositionFacts, isSerious, lineSan, ownGames, positionFacts, repeatedRefs, uciOf } from './explain';
import type { PositionFacts } from './positionFacts';
import type { StudentFile } from './student';

export type { Attempt } from '../server/views';

export interface Ref {
  gameId: string;
  ply: number;
}

/** A position's reference as one string, for exclude lists: "<gameId>#<ply>". */
export const refKey = (gameId: string, ply: number): string => `${gameId}#${ply}`;

function parseRefKey(k: string): Ref | null {
  const i = k.lastIndexOf('#');
  const ply = Number(k.slice(i + 1));
  return i > 0 && Number.isInteger(ply) ? { gameId: k.slice(0, i), ply } : null;
}

/**
 * A move typed or played in `fen`, read the way chess.js reads it: SAN with or without check
 * signs or annotations ("Nf6", "Nf6+", "Bc5!?"), castling as "O-O" or "0-0", or UCI ("g8f6",
 * "e1g1"). Null when it isn't a legal move there.
 */
export function parseAttempt(fen: string, move: string): Move | null {
  const typed = move.trim();
  if (!typed) return null;
  try {
    return new Chess(fen).move(typed);
  } catch {
    return null;
  }
}

/**
 * The mover's win % after `m`, at display depth, and the opponent's best line in reply.
 * Checkmate and stalemate after the move are decided by the rules (100% and 50%), unsearched.
 */
export async function moveOutcome(m: Move, engine: DisplayEngine): Promise<{ win: number; replySan: string[] | null }> {
  const after = new Chess(m.after);
  if (after.isCheckmate()) return { win: 100, replySan: null };
  if (after.isStalemate()) return { win: 50, replySan: null };
  const e = await engine.evaluate(m.after, DISPLAY_CFG.movetimeMs);
  // The search is from the opponent's side: flip it.
  return { win: 100 - evalToWinPct(e.cp, e.mate), replySan: lineSan(m.after, e) };
}

export type CheckResult =
  | { legal: false; playedInGame: string }
  | {
      legal: true;
      /** The move lost at most REPEAT_CFG.wrongLossPts win-% against the best move, at display depth. */
      correct: boolean;
      /** Win-% points lost against the best move (0 for the best move itself). */
      lossPts: number;
      /** The move played in the game here (SAN). */
      playedInGame: string;
      /** The deep facts of the position and the game move, for the answer view. */
      facts: PositionFacts;
      /** The tried move in the board's form: SAN, and UCI from+to+promotion (castling = the king's move). */
      attempt: Attempt;
      /** The mover's win % after the tried move, at display depth. */
      attemptWin: number;
      /** The mover's win % with the best move (the position's value before the move). */
      bestWin: number;
      isBest: boolean;
      isGameMove: boolean;
      /** The opponent's best line after the tried move (null for the best move, mate or stalemate). */
      attemptRefutationSan: string[] | null;
    };

/**
 * Scores a move the player tried in the position before `ply` of a cached game, at display
 * depth. An illegal move gives `legal: false` before any search. Otherwise the position and
 * the game move get their deep facts (`deepPositionFacts`, the same as on the answer board),
 * and the tried move is compared with the deep best move:
 * - the best move itself: no loss, and no further search (one move, one number);
 * - the game move: its deep facts' numbers and refutation;
 * - any other move: the position after it is searched once at display depth.
 * `correct` when the loss is at most REPEAT_CFG.wrongLossPts, the same line that makes a
 * repeated position's move count as wrong.
 */
export async function checkMove(c: CachedGame, ply: number, moveSan: string, engine: DisplayEngine): Promise<CheckResult> {
  const base = positionFacts(c, ply); // from the cache: no search; throws on a ply outside the game
  const m = parseAttempt(base.fenBefore, moveSan);
  if (!m) return { legal: false, playedInGame: base.playedSan };

  const facts = await deepPositionFacts(c, ply, engine);
  const attempt: Attempt = { moveSan: m.san, moveUci: uciOf(m) };
  const isBest = attempt.moveUci === (facts.bestUci ?? facts.playedUci);
  const isGameMove = attempt.moveUci === facts.playedUci;
  let attemptWin: number;
  let attemptRefutationSan: string[] | null;
  if (isBest) {
    attemptWin = facts.winBefore;
    attemptRefutationSan = null;
  } else if (isGameMove) {
    attemptWin = facts.winAfter;
    attemptRefutationSan = facts.refutationSan;
  } else {
    const o = await moveOutcome(m, engine);
    attemptWin = o.win;
    attemptRefutationSan = o.replySan;
  }
  const lossPts = isBest ? 0 : Math.max(0, facts.winBefore - attemptWin);
  return {
    legal: true,
    correct: lossPts <= REPEAT_CFG.wrongLossPts,
    lossPts,
    playedInGame: facts.playedSan,
    facts,
    attempt,
    attemptWin,
    bestWin: facts.winBefore,
    isBest,
    isGameMove,
    attemptRefutationSan,
  };
}

/**
 * Worth asking: on the deep check the game move is still a mistake or a blunder (so it lost at
 * least DELTA.mistake, more than REPEAT_CFG.wrongLossPts, and `checkMove` calls it wrong too),
 * and it is not the deep best move. A quick-check mistake the deep check clears
 * (`deepDisagrees`) is never asked; neither is a move that is only an inaccuracy at depth.
 */
export function isTeachable(quick: Classification, deep: PositionFacts): boolean {
  return (
    !deepDisagrees(quick, deep.classification) &&
    isSerious(deep.classification) &&
    deep.bestUci !== null &&
    deep.winBefore - deep.winAfter > REPEAT_CFG.wrongLossPts
  );
}

/** Right answers, each in a different session, after which a board counts as learned. */
export const DRILLS_PER_POSITION = 3;

/** The board (position key) at a game's ply, from `games` or else the cache; null if unknown. */
function boardKeyFinder(games: Map<string, CachedGame>): (gameId: string, ply: number) => string | null {
  const known = new Map<string, string | null>();
  return (gameId, ply) => {
    const k = refKey(gameId, ply);
    if (!known.has(k)) {
      const c = games.get(gameId) ?? readCached(gameId);
      const fen = c ? gamePlies(c)?.[ply]?.fenBefore : undefined;
      known.set(k, fen ? positionKey(fen) : null);
    }
    return known.get(k)!;
  };
}

/**
 * For each board (position key), the indexes of the student's sessions with a right answer
 * there; the same board reached in another game counts as the same board.
 */
export function rightSessionsByBoard(student: StudentFile | undefined, games: Map<string, CachedGame>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  if (!student) return out;
  const keyOf = boardKeyFinder(games);
  student.sessions.forEach((s, i) => {
    for (const t of s.tried) {
      if (!t.correct) continue;
      const key = keyOf(t.gameId, t.ply);
      if (!key) continue;
      if (!out.has(key)) out.set(key, new Set());
      out.get(key)!.add(i);
    }
  });
  return out;
}

/**
 * What practice leaves out, from the student file (as refKeys): everything tried in the
 * running session (`current`, its index), and boards already answered right in
 * DRILLS_PER_POSITION different sessions. A board got wrong, or right fewer times, comes back
 * in a later session: that spacing is the point of practice.
 */
export function practiceExclusions(student: StudentFile, current: number | null, games: Map<string, CachedGame>): string[] {
  const right = rightSessionsByBoard(student, games);
  const keyOf = boardKeyFinder(games);
  const out: string[] = [];
  student.sessions.forEach((s, i) => {
    for (const t of s.tried) {
      const key = keyOf(t.gameId, t.ply);
      const learned = key !== null && (right.get(key)?.size ?? 0) >= DRILLS_PER_POSITION;
      if (i === current || learned) out.push(refKey(t.gameId, t.ply));
    }
  });
  return out;
}

/**
 * The first of `refs` worth asking, deep-checking them in order (at most `maxChecks` deep
 * checks, about 3 s each). `skipped` lists the refs passed over: games not in the cache or not
 * replayable, and positions the deep check cleared. Search failures are thrown.
 */
export async function firstTeachable(
  refs: Ref[],
  load: (gameId: string) => CachedGame | null,
  deep: (c: CachedGame, ply: number) => Promise<PositionFacts>,
  maxChecks: number,
): Promise<{ found: { c: CachedGame; ply: number; facts: PositionFacts } | null; skipped: Ref[] }> {
  const skipped: Ref[] = [];
  let checks = 0;
  for (const ref of refs) {
    const c = load(ref.gameId);
    const quick = c?.analysis.plies[ref.ply]?.classification;
    if (!c || !quick || !gamePlies(c)?.[ref.ply]) {
      skipped.push(ref);
      continue;
    }
    if (checks >= maxChecks) break;
    checks++;
    const facts = await deep(c, ref.ply);
    if (isTeachable(quick, facts)) return { found: { c, ply: ref.ply, facts }, skipped };
    skipped.push(ref);
  }
  return { found: null, skipped };
}

type Pick = { gameId: string; ply: number; key: string; loss: number };

const worstFirst = (a: Pick, b: Pick) => b.loss - a.loss || a.gameId.localeCompare(b.gameId) || a.ply - b.ply;

/**
 * Up to `n` more of the player's own positions with the same pattern as the diagnosis focus,
 * in the order to ask them. Candidates only: ask them through `firstTeachable`.
 * - Focus area: the player's serious mistakes in that area. Each game's worst first (worst
 *   of those first), then each game's second worst, and so on, so one bad game can't fill it.
 * - Focus repeated positions: one reference per position (the sighting that lost the most),
 *   the focus positions first, then the other repeated positions.
 * - No focus: none.
 * Never a position listed in `exclude` ("<gameId>#<ply>", see `refKey`), nor the same board
 * as one of them, and never the same board twice.
 */
export function samePatternPositions(d: Diagnosis, games: CachedGame[], exclude: string[], n: number): Ref[] {
  const focus = d.focus;
  if (!focus || n <= 0) return [];
  const own = ownGames(d, games);
  const pliesOf = new Map<string, PlyFact[]>(own.map((g) => [g.c.game.id, g.plies]));

  const excludedRefs = new Set(exclude);
  const excludedKeys = new Set<string>();
  for (const k of exclude) {
    const ref = parseRefKey(k);
    const fact = ref ? pliesOf.get(ref.gameId)?.[ref.ply] : undefined;
    if (fact) excludedKeys.add(positionKey(fact.fenBefore));
  }

  const ordered: Pick[] = [];
  if (focus.kind === 'area') {
    const perGame = own.map(({ c, plies }) =>
      plies
        .filter((p) => p.mine && p.mistake && p.areas.includes(focus.area))
        .map((p) => ({ gameId: c.game.id, ply: p.ply, key: positionKey(p.fenBefore), loss: p.lossPts }))
        .sort(worstFirst),
    );
    const deepest = Math.max(0, ...perGame.map((l) => l.length));
    for (let rank = 0; rank < deepest; rank++) {
      ordered.push(...perGame.flatMap((l) => (l[rank] ? [l[rank]] : [])).sort(worstFirst));
    }
  } else {
    const refs = repeatedRefs(d, games);
    const focusKeys = new Set(focus.keys);
    const order = d.repeated.map((r, i) => ({ r, ref: refs[i] }));
    const sorted = [
      ...focus.keys.flatMap((k) => order.filter((x) => x.r.key === k)),
      ...order.filter((x) => !focusKeys.has(x.r.key)),
    ];
    for (const { r, ref } of sorted) if (ref) ordered.push({ ...ref, key: r.key, loss: r.avgLossPts });
  }

  const out: Ref[] = [];
  const used = new Set<string>();
  for (const p of ordered) {
    if (out.length >= n) break;
    if (excludedRefs.has(refKey(p.gameId, p.ply)) || excludedKeys.has(p.key) || used.has(p.key)) continue;
    used.add(p.key);
    out.push({ gameId: p.gameId, ply: p.ply });
  }
  return out;
}
