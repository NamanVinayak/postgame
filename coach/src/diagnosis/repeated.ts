import type { CachedGame } from '../analysis/cache';
import { REPEAT_CFG } from '../config';
import { customStartFen, gamePlies, type PlyFact } from './areas';

/** A position the player keeps reaching and keeps getting wrong. */
export interface RepeatedPosition {
  /** First four FEN fields (board, side to move, castling, en passant). */
  key: string;
  /** Full FEN from one example game. */
  fen: string;
  /** SAN moves from the start to this position, from the same example game. */
  movesFromStart: string[];
  /** Games in which the player had to move here (each game counts once). */
  seen: number;
  /** How many of those moves lost at least REPEAT_CFG.wrongLossPts win-% points. */
  wrong: number;
  /** Average win-% points lost over the wrong moves. */
  avgLossPts: number;
  /** Every move the player chose here, most frequent first, with its average loss. */
  usual: { move: string; times: number; avgLossPts: number }[];
  /** The engine's preferred move, as recorded when the player went wrong (most common if it varies). */
  best: string;
  gameIds: string[];
}

/** Identifies a position regardless of move counters: board, side to move, castling, en passant. */
export function positionKey(fen: string): string {
  return fen.split(' ', 4).join(' ');
}

interface Sighting {
  gameId: string;
  fact: PlyFact;
  plies: PlyFact[];
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
  return best;
}

/**
 * Positions where the player was to move in at least REPEAT_CFG.minSeen games, went wrong
 * (lost ≥ wrongLossPts) at least minWrong times, and lost on average ≥ minAvgLossPts on those
 * wrong moves. A position that recurs inside one game counts once for that game (its first
 * occurrence). Games set up from a custom position are skipped, because `movesFromStart`
 * must replay from the usual start. Sorted by average loss × wrong count, largest first.
 */
export function findRepeated(games: CachedGame[]): RepeatedPosition[] {
  const byKey = new Map<string, Sighting[]>();
  for (const c of games) {
    if (customStartFen(c.game.pgn)) continue;
    const plies = gamePlies(c);
    if (!plies) continue;
    const seenHere = new Set<string>();
    for (const fact of plies) {
      if (!fact.mine) continue;
      const key = positionKey(fact.fenBefore);
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      const list = byKey.get(key);
      const s = { gameId: c.game.id, fact, plies };
      if (list) list.push(s);
      else byKey.set(key, [s]);
    }
  }

  const found: RepeatedPosition[] = [];
  for (const [key, sightings] of byKey) {
    if (sightings.length < REPEAT_CFG.minSeen) continue;
    const wrong = sightings.filter((s) => s.fact.lossPts >= REPEAT_CFG.wrongLossPts);
    if (wrong.length < REPEAT_CFG.minWrong) continue;
    const avgLossPts = wrong.reduce((sum, s) => sum + s.fact.lossPts, 0) / wrong.length;
    if (avgLossPts < REPEAT_CFG.minAvgLossPts) continue;

    const moves = new Map<string, { times: number; loss: number }>();
    for (const s of sightings) {
      const m = moves.get(s.fact.san) ?? { times: 0, loss: 0 };
      m.times++;
      m.loss += s.fact.lossPts;
      moves.set(s.fact.san, m);
    }
    const usual = [...moves]
      .map(([move, m]) => ({ move, times: m.times, avgLossPts: m.loss / m.times }))
      .sort((a, b) => b.times - a.times || b.avgLossPts - a.avgLossPts || a.move.localeCompare(b.move));
    const best =
      mostCommon(wrong.map((s) => s.fact.bestSan).filter((b): b is string => b !== null)) ??
      mostCommon(sightings.map((s) => s.fact.bestSan ?? s.fact.san))!;
    const example = sightings[0];
    found.push({
      key,
      fen: example.fact.fenBefore,
      movesFromStart: example.plies.slice(0, example.fact.ply).map((p) => p.san),
      seen: sightings.length,
      wrong: wrong.length,
      avgLossPts,
      usual,
      best,
      gameIds: sightings.map((s) => s.gameId),
    });
  }
  return found.sort(
    (a, b) => b.avgLossPts * b.wrong - a.avgLossPts * a.wrong || b.seen - a.seen || a.key.localeCompare(b.key),
  );
}
