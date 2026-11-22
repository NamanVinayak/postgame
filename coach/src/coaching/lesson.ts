/**
 * The "you try first" part of a coaching session (spec §6b, step 4–5): scoring a move the
 * player tried at display depth, and choosing positions of the same pattern to ask.
 *
 * Everything shown or named comes from a deep search (a `DisplayEngine`); the cached quick
 * analysis only proposes candidates. A position is only asked if the deep check agrees that
 * the game move really went wrong there (`isTeachable`).
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
import { commonOpening, openingFamily, openingName } from './openings';
import type { Attempted, StudentFile, StudentSession } from './student';

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
 * The tried move in the position before `ply` of a cached game, without any search: null when
 * it isn't legal there (or is ambiguous, e.g. "Nd2" when two knights can go), or the ply isn't
 * in the game.
 */
export function legalAttempt(c: CachedGame, ply: number, moveSan: string): Move | null {
  const fen = gamePlies(c)?.[ply]?.fenBefore;
  return fen ? parseAttempt(fen, moveSan) : null;
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
 * What a practice candidate is, which decides how it is checked:
 * - 'repeated': a position the player keeps reaching and keeps getting wrong (the diagnosis's
 *   repeated positions; one sighting stands for the position);
 * - 'mistake': one move the quick check called a mistake or blunder.
 */
export type PracticeKind = 'repeated' | 'mistake';

export interface PracticeRef extends Ref {
  kind: PracticeKind;
}

/**
 * Worth asking, judged on the deep check. For both kinds the game move must not be the deep
 * best move and must lose more than REPEAT_CFG.wrongLossPts: the line `checkMove` uses, so
 * the game move itself would be scored wrong. A 'mistake' must also still be a mistake or a
 * blunder at depth: never one the deep check clears (`deepDisagrees`), nor one that is only
 * an inaccuracy there. A 'repeated' position needs only the first rule, the same line that
 * makes a move count as wrong there.
 */
export function isTeachable(kind: PracticeKind, quick: Classification, deep: PositionFacts): boolean {
  if (deep.bestUci === null || deep.winBefore - deep.winAfter <= REPEAT_CFG.wrongLossPts) return false;
  return kind === 'repeated' || (!deepDisagrees(quick, deep.classification) && isSerious(deep.classification));
}

/** Sessions whose first try at a board was right, after which the board counts as learned. */
export const DRILLS_PER_POSITION = 3;

/** Finds the board (position key) at a game's ply, from `games` or else the cache; null if unknown. */
export function boardKeyFinder(games: Map<string, CachedGame>): (gameId: string, ply: number) => string | null {
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

type KeyOf = (gameId: string, ply: number) => string | null;
const boardOf = (t: Attempted, keyOf: KeyOf) => t.key ?? keyOf(t.gameId, t.ply);

/** True when the session already holds a try at this board: only the first try at a position counts. */
export function triedBoard(session: StudentSession, key: string, keyOf: KeyOf): boolean {
  return session.tried.some((t) => boardOf(t, keyOf) === key);
}

/**
 * For each board (position key), the indexes of the student's sessions whose FIRST try at that
 * board was right. The same board reached in another game is the same board. A right answer
 * after a wrong one in the same session doesn't count: the answer had been shown by then.
 */
export function rightSessionsByBoard(student: StudentFile | undefined, games: Map<string, CachedGame>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  if (!student) return out;
  const keyOf = boardKeyFinder(games);
  student.sessions.forEach((s, i) => {
    const seen = new Set<string>();
    for (const t of s.tried) {
      const key = boardOf(t, keyOf);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!t.correct) continue;
      if (!out.has(key)) out.set(key, new Set());
      out.get(key)!.add(i);
    }
  });
  return out;
}

/**
 * What practice leaves out, from the student file (as refKeys): everything tried in the
 * running session (`current`, its index), and boards learned (first try right in
 * DRILLS_PER_POSITION different sessions). A board got wrong, or right fewer times, comes back
 * in a later session: that spacing is the point of practice.
 */
export function practiceExclusions(student: StudentFile, current: number | null, games: Map<string, CachedGame>): string[] {
  const right = rightSessionsByBoard(student, games);
  const keyOf = boardKeyFinder(games);
  const out: string[] = [];
  student.sessions.forEach((s, i) => {
    for (const t of s.tried) {
      const key = boardOf(t, keyOf);
      const learned = key !== null && (right.get(key)?.size ?? 0) >= DRILLS_PER_POSITION;
      if (i === current || learned) out.push(refKey(t.gameId, t.ply));
    }
  });
  return out;
}

/**
 * The first of `refs` worth asking (`isTeachable`, by each ref's kind; 'mistake' when none is
 * given), deep-checking them one at a time in order, at most `maxChecks` (about 3 s each).
 * `skipped` lists the refs passed over: games not in the cache or not replayable, and
 * positions the deep check cleared. Search failures are thrown.
 */
export async function firstTeachable(
  refs: (Ref & { kind?: PracticeKind })[],
  load: (gameId: string) => CachedGame | null,
  deep: (c: CachedGame, ply: number) => Promise<PositionFacts>,
  maxChecks: number,
): Promise<{ found: { c: CachedGame; ply: number; facts: PositionFacts; kind: PracticeKind } | null; skipped: Ref[] }> {
  const skipped: Ref[] = [];
  let checks = 0;
  for (const ref of refs) {
    const c = load(ref.gameId);
    const quick = c?.analysis.plies[ref.ply]?.classification;
    if (!c || !quick || !gamePlies(c)?.[ref.ply]) {
      skipped.push({ gameId: ref.gameId, ply: ref.ply });
      continue;
    }
    if (checks >= maxChecks) break;
    checks++;
    const kind = ref.kind ?? 'mistake';
    const facts = await deep(c, ref.ply);
    if (isTeachable(kind, quick, facts)) return { found: { c, ply: ref.ply, facts, kind }, skipped };
    skipped.push({ gameId: ref.gameId, ply: ref.ply });
  }
  return { found: null, skipped };
}

/** The opening top-up only takes mistakes up to this move number. */
export const OPENING_TOPUP_MOVES = 15;

type Pick = { gameId: string; ply: number; key: string; loss: number; kind: PracticeKind };

const worstFirst = (a: Pick, b: Pick) => b.loss - a.loss || a.gameId.localeCompare(b.gameId) || a.ply - b.ply;

/** Each game's worst first (worst of those first), then each game's second worst, and so on: one bad game can't fill the list. */
function roundRobin(perGame: Pick[][]): Pick[] {
  const lists = perGame.map((l) => [...l].sort(worstFirst));
  const out: Pick[] = [];
  const deepest = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < deepest; rank++) out.push(...lists.flatMap((l) => (l[rank] ? [l[rank]] : [])).sort(worstFirst));
  return out;
}

/**
 * The player's practice positions for the diagnosis focus, in the order to ask them (up to
 * `n`). Candidates only: ask them through `firstTeachable`, which deep-checks each by its kind.
 * - Focus area: the player's serious mistakes in that area ('mistake'), round-robin by game.
 * - Focus repeated positions ('repeated', one reference each: the sighting that lost the
 *   most): the focus positions first; then, to top up, the player's other repeated positions;
 *   then the player's quick-check mistakes and blunders ('mistake') in the first
 *   OPENING_TOPUP_MOVES moves of games in the same opening family as the focus positions
 *   (e.g. "Sicilian Defense"), round-robin by game.
 * - No focus: none.
 * Never a position listed in `exclude` ("<gameId>#<ply>", see `refKey`), nor the same board
 * as one of them, and never the same board twice.
 */
export function samePatternPositions(d: Diagnosis, games: CachedGame[], exclude: string[], n: number): PracticeRef[] {
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

  const mistakes = (keep: (p: PlyFact, c: CachedGame) => boolean, from = own) =>
    roundRobin(
      from.map(({ c, plies }) =>
        plies
          .filter((p) => p.mine && p.mistake && keep(p, c))
          .map((p) => ({ gameId: c.game.id, ply: p.ply, key: positionKey(p.fenBefore), loss: p.lossPts, kind: 'mistake' as const })),
      ),
    );

  const ordered: Pick[] = [];
  if (focus.kind === 'area') {
    ordered.push(...mistakes((p) => p.areas.includes(focus.area)));
  } else {
    const refs = repeatedRefs(d, games);
    const focusKeys = new Set(focus.keys);
    const order = d.repeated.map((r, i) => ({ r, ref: refs[i] }));
    const sorted = [
      ...focus.keys.flatMap((k) => order.filter((x) => x.r.key === k)),
      ...order.filter((x) => !focusKeys.has(x.r.key)),
    ];
    for (const { r, ref } of sorted) if (ref) ordered.push({ ...ref, key: r.key, loss: r.avgLossPts, kind: 'repeated' });

    // Top-up: early mistakes in games of the focus positions' opening families.
    const byId = new Map(own.map((g) => [g.c.game.id, g.c]));
    const familyOf = (c: CachedGame) => {
      const name = openingName(c.game.pgn);
      return name ? openingFamily(name) : null;
    };
    const families = new Set<string>();
    for (const r of d.repeated.filter((x) => focusKeys.has(x.key))) {
      const names = r.gameIds.map((id) => byId.get(id)).map((c) => (c ? openingName(c.game.pgn) : null));
      const common = commonOpening(names.filter((x): x is string => x !== null));
      if (common) families.add(openingFamily(common));
    }
    if (families.size > 0) {
      const sameFamily = own.filter(({ c }) => {
        const f = familyOf(c);
        return f !== null && families.has(f);
      });
      ordered.push(...mistakes((p) => Math.floor(p.ply / 2) + 1 <= OPENING_TOPUP_MOVES, sameFamily));
    }
  }

  const out: PracticeRef[] = [];
  const used = new Set<string>();
  for (const p of ordered) {
    if (out.length >= n) break;
    if (excludedRefs.has(refKey(p.gameId, p.ply)) || excludedKeys.has(p.key) || used.has(p.key)) continue;
    used.add(p.key);
    out.push({ gameId: p.gameId, ply: p.ply, kind: p.kind });
  }
  return out;
}
