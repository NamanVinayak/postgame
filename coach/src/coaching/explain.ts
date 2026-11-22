import { Chess } from 'chess.js';
import { classifyMove, isMiss, isMissedWin } from '../../../src/analysis/classify';
import { uciLineToSan } from '../../../src/analysis/lines';
import { explainMistake } from '../../../src/analysis/reasons';
import { evalToWinPct } from '../../../src/analysis/winPct';
import { BEST_LINE_MAX_MOVES } from '../../../src/constants';
import type { Engine, Evaluation } from '../../../src/services/engine/types';
import type { Color } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { DISPLAY_CFG, REPEAT_CFG } from '../config';
import { gamePlies, type PlyFact } from '../diagnosis/areas';
import type { Diagnosis } from '../diagnosis/diagnose';
import { positionKey } from '../diagnosis/repeated';
import type { PositionFacts } from './positionFacts';

export type { PositionFacts } from './positionFacts';

/** A played move in the same UCI form the engine uses ("e7e8q"). */
function uciOf(m: { from: string; to: string; promotion?: string }): string {
  return m.from + m.to + (m.promotion ?? '');
}

/** UCI for a SAN move in a position; null when it is missing or not legal there. */
function sanToUci(fen: string, san: string | null): string | null {
  if (!san) return null;
  try {
    return uciOf(new Chess(fen).move(san));
  } catch {
    return null;
  }
}

/** The replayed move at `ply`, plus the position after it. Throws on a ply outside the game. */
function playedMove(c: CachedGame, ply: number): { fact: PlyFact; fenAfter: string; uci: string } {
  const plies = gamePlies(c);
  if (!plies) throw new Error(`Game ${c.game.id} could not be replayed`);
  if (!Number.isInteger(ply) || ply < 0 || ply >= plies.length) {
    throw new Error(`Game ${c.game.id} has plies 0 to ${plies.length - 1}; ply ${ply} is not one of them`);
  }
  const fact = plies[ply];
  const m = new Chess(fact.fenBefore).move(fact.san);
  return { fact, fenAfter: m.after, uci: uciOf(m) };
}

/** White's win % (0..100) turned into `mover`'s. */
const forMover = (winWhite: number, mover: Color) => (mover === 'white' ? winWhite : 100 - winWhite);

/**
 * One move of a cached game, as the quick (ENGINE_CFG) analysis saw it. Win % are the mover's:
 * before = after the previous ply (50 before the first move, which has no cached eval), after =
 * after this ply. `bestSan` is the cache's `bestMoveSan` (null when the move was best or within
 * noise of it); the refutation is the next ply's best line. For choosing positions only:
 * anything shown or named to the player goes through `deepPositionFacts` first.
 */
export function positionFacts(c: CachedGame, ply: number): PositionFacts {
  const { fact, fenAfter, uci } = playedMove(c, ply);
  const plies = c.analysis.plies;
  const p = plies[ply];
  const bestUci = sanToUci(fact.fenBefore, p.bestMoveSan);
  return {
    gameId: c.game.id,
    ply,
    fenBefore: fact.fenBefore,
    fenAfter,
    mover: fact.mover,
    playedSan: p.moveSan,
    playedUci: uci,
    bestSan: bestUci ? p.bestMoveSan : null,
    bestUci,
    bestLineSan: p.bestLineSan,
    refutationSan: plies[ply + 1]?.bestLineSan ?? null,
    winBefore: ply === 0 ? 50 : forMover(plies[ply - 1].winPctWhite, fact.mover),
    winAfter: forMover(p.winPctWhite, fact.mover),
    classification: p.classification,
    reason: p.reason,
    gameUrl: c.game.url,
  };
}

/** The engine's line from `fen` in SAN (at most BEST_LINE_MAX_MOVES), or null when there is none. */
function lineSan(fen: string, e: Evaluation): string[] | null {
  const pv = e.pvUci && e.pvUci.length > 0 ? e.pvUci : e.bestMoveUci ? [e.bestMoveUci] : null;
  return pv ? uciLineToSan(fen, pv.slice(0, BEST_LINE_MAX_MOVES)) : null;
}

/**
 * The same move re-searched at display depth (the engine should be built with DISPLAY_CFG).
 * Searches fenBefore (the mover to play) and fenAfter (the opponent to play) once each, and
 * replaces everything engine-made: win % (both the mover's), best move and line, the
 * refutation (the opponent's best line after the played move), and the classification and
 * reason derived from them, so no quick-search move can reach the screen next to a deep one.
 * `bestSan`/`bestUci` are null only when the played move is the deep search's first choice.
 * Checkmate or stalemate after the move is scored by the rules (100 / 50), without a search.
 */
export async function deepPositionFacts(c: CachedGame, ply: number, engine: Engine): Promise<PositionFacts> {
  const base = positionFacts(c, ply);
  const before = await engine.evaluate(base.fenBefore, DISPLAY_CFG.movetimeMs);
  const after = new Chess(base.fenAfter);
  const mate = after.isCheckmate();
  const terminal = mate || after.isStalemate();
  const afterEval = terminal ? null : await engine.evaluate(base.fenAfter, DISPLAY_CFG.movetimeMs);

  const winBefore = evalToWinPct(before.cp, before.mate);
  // The after-search is from the opponent's side: flip it (never a mate-0 eval: terminal positions aren't searched).
  const winAfter = afterEval ? 100 - evalToWinPct(afterEval.cp, afterEval.mate) : mate ? 100 : 50;
  const bestLineSan = lineSan(base.fenBefore, before);
  const engineBestUci = before.bestMoveUci ?? before.pvUci?.[0] ?? null;
  // A missing or unplayable best move must not read as "the played move was best" on the board.
  const engineBestSan = engineBestUci ? (uciLineToSan(base.fenBefore, [engineBestUci])?.[0] ?? null) : null;
  if (!engineBestUci || !engineBestSan) throw new Error('Stockfish gave no usable best move for this position');
  const playedIsBest = engineBestUci === base.playedUci;
  const bestUci = playedIsBest ? null : engineBestUci;
  const bestSan = playedIsBest ? null : engineBestSan;
  const refutationSan = afterEval ? lineSan(base.fenAfter, afterEval) : null;

  const loss = Math.max(0, winBefore - winAfter);
  const forced = new Chess(base.fenBefore).moves().length === 1;
  const classification = forced ? 'best' : classifyMove(loss, playedIsBest);
  const couldChoose = !forced && !playedIsBest;
  const missedWin = couldChoose && isMissedWin(winBefore, winAfter);
  const miss = couldChoose && !missedWin && isMiss(winBefore, winAfter);
  const reason = explainMistake({
    fenBefore: base.fenBefore,
    fenAfter: base.fenAfter,
    playedSan: base.playedSan,
    bestMoveSan: bestSan,
    classification,
    isMissedWin: missedWin,
    isMiss: miss,
    bestLeadsToMate: before.mate !== null && before.mate > 0,
    opponentReplySan: refutationSan?.[0] ?? null,
  });

  return {
    ...base,
    bestSan,
    bestUci,
    bestLineSan,
    refutationSan,
    winBefore,
    winAfter,
    classification,
    reason,
  };
}

/** The named accounts' replayable games, with their plies. */
function ownGames(d: Diagnosis, games: CachedGame[]): { c: CachedGame; plies: PlyFact[] }[] {
  const named = new Set(d.usernames.map((u) => u.toLowerCase()));
  const out: { c: CachedGame; plies: PlyFact[] }[] = [];
  for (const c of games) {
    if (!named.has(c.game.username.toLowerCase())) continue;
    const plies = gamePlies(c);
    if (plies) out.push({ c, plies });
  }
  return out;
}

const byLossThenId = (a: { loss: number; c: CachedGame; ply: number }, b: { loss: number; c: CachedGame; ply: number }) =>
  b.loss - a.loss || a.c.game.id.localeCompare(b.c.game.id) || a.ply - b.ply;

/**
 * Up to `n` of the player's own moves that show the diagnosis focus, from the cache:
 * - focus area: the player's serious mistakes (mistake or blunder) in that area, the worst
 *   win-% loss from each game, worst first (one per game, so one bad game can't fill the list);
 * - focus repeated positions: for each focus position in order, the sighting (first time in a
 *   game) where the player lost the most, if it lost at least REPEAT_CFG.wrongLossPts;
 * - no focus: none.
 * These are candidates only: callers must run `deepPositionFacts` before showing or naming
 * anything about them.
 */
export function examplePositions(d: Diagnosis, games: CachedGame[], n: number): PositionFacts[] {
  const focus = d.focus;
  if (!focus || n <= 0) return [];
  const own = ownGames(d, games);
  const picks: { c: CachedGame; ply: number; loss: number }[] = [];

  if (focus.kind === 'area') {
    for (const { c, plies } of own) {
      const worst = plies
        .filter((p) => p.mine && p.mistake && p.areas.includes(focus.area))
        .map((p) => ({ c, ply: p.ply, loss: p.lossPts }))
        .sort(byLossThenId)[0];
      if (worst) picks.push(worst);
    }
    picks.sort(byLossThenId);
  } else {
    for (const key of focus.keys) {
      const sightings: { c: CachedGame; ply: number; loss: number }[] = [];
      for (const { c, plies } of own) {
        const first = plies.find((p) => p.mine && positionKey(p.fenBefore) === key);
        if (first && first.lossPts >= REPEAT_CFG.wrongLossPts) sightings.push({ c, ply: first.ply, loss: first.lossPts });
      }
      const worst = sightings.sort(byLossThenId)[0];
      if (worst) picks.push(worst);
    }
  }
  return picks.slice(0, n).map((p) => positionFacts(p.c, p.ply));
}
