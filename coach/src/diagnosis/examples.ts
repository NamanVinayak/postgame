/**
 * The games behind a finding of the report (spec §6c drill-down, plan Task P5): for one source,
 * a page of the player's own games, each with the move where it slipped. Cached quick analysis
 * only: no engine, and no best move anywhere (rows are built field by field). The numbers are
 * the quick check's, labelled as such; a position is deep-checked only when it is asked.
 *
 * Sources:
 * - 'thrownWins': games the player was clearly winning (LEAK_CFG's sustained rule,
 *   `sustainedWinningPly`, the same as the report's conversion) and lost. The slip is the
 *   player's biggest single win-% drop from the move that made them clearly winning on (ties:
 *   the earliest), so a game lost on time without any drop shows that first winning move.
 * - a LeakKey: one row per game, the player's biggest-loss costly move (a drop of
 *   COSTLY_DROP_PTS or more) in that situation (ties: the earliest).
 * - 'quickFix' with `key`: a position the player keeps reaching and getting wrong
 *   (`findRepeated`); one row per game that reached it, the slip being the player's move there.
 * Every list is newest game first. Opponents appear by rating only, never by name.
 */
import { Chess } from 'chess.js';
import type { Color, Outcome } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { customStartFen, gamePlies, type PlyFact } from './areas';
import { LEAK_KEYS, LEAK_LABELS, costlyMoves, sustainedWinningPly, type LeakKey } from './leaks';
import { findRepeated, positionKey } from './repeated';

export type ExampleSource = 'thrownWins' | LeakKey | 'quickFix';
export const EXAMPLE_SOURCES: readonly ExampleSource[] = ['thrownWins', ...LEAK_KEYS, 'quickFix'];

export interface ExampleRow {
  gameId: string;
  gameUrl: string | null;
  /** ISO date 'YYYY-MM-DD' (UTC) of the game end. */
  date: string;
  opponentRating: number | null;
  result: Outcome;
  myColor: Color;
  /** The same 0-based ply coach_ask_position takes. */
  slipPly: number;
  /** The chess move number shown to people ("Move 23"). */
  slipMoveNo: number;
  fenBefore: string;
  playedSan: string;
  playedUci: string;
  /** The player's win % before and after the move, from the fast cached analysis. */
  quickWinBefore: number;
  quickWinAfter: number;
  /** The player's win % after each ply, from the cache, downsampled to at most TIMELINE_MAX_POINTS. */
  timeline: number[];
  /** The index in `timeline` of the slip (its own point is always one of them). */
  slipIndex: number;
}

export interface ExamplesPage {
  kind: 'examples';
  source: ExampleSource;
  key?: string;
  title: string;
  total: number;
  offset: number;
  limit: number;
  numbersLabel: 'quick check';
  examples: ExampleRow[];
}

export interface ExamplesRequest {
  source: ExampleSource;
  key?: string;
  offset?: number;
  limit?: number;
}

/** Rows per page, at most. */
export const EXAMPLES_MAX_LIMIT = 10;
/** Points in a row's timeline, at most. */
export const TIMELINE_MAX_POINTS = 80;

const round1 = (x: number) => Math.round(x * 10) / 10;

/** A game and the player's ply to show from it. */
interface Slip {
  c: CachedGame;
  plies: PlyFact[];
  ply: number;
}

/** The named accounts' replayable games, with their plies. */
function own(games: CachedGame[], usernames: string[]): { c: CachedGame; plies: PlyFact[] }[] {
  const named = new Set(usernames.map((u) => u.toLowerCase()));
  const out: { c: CachedGame; plies: PlyFact[] }[] = [];
  for (const c of games) {
    if (!named.has(c.game.username.toLowerCase())) continue;
    const plies = gamePlies(c);
    if (plies) out.push({ c, plies });
  }
  return out;
}

const newestFirst = (a: Slip, b: Slip) => b.c.game.endTime - a.c.game.endTime || a.c.game.id.localeCompare(b.c.game.id);

/** The player's move with the biggest drop among `moves` (ties: the earliest). */
function biggestDrop(moves: PlyFact[]): PlyFact | undefined {
  let best: PlyFact | undefined;
  for (const p of moves) if (!best || p.lossPts > best.lossPts) best = p;
  return best;
}

function thrownWins(games: CachedGame[], usernames: string[]): Slip[] {
  const out: Slip[] = [];
  for (const { c, plies } of own(games, usernames)) {
    if (c.game.outcome !== 'loss') continue;
    const from = sustainedWinningPly(plies, true);
    if (from === null) continue;
    const slip = biggestDrop(plies.filter((p) => p.mine && p.ply >= from));
    if (slip) out.push({ c, plies, ply: slip.ply });
  }
  return out.sort(newestFirst);
}

function leakSlips(games: CachedGame[], usernames: string[], key: LeakKey): Slip[] {
  const byGame = new Map<string, Slip & { loss: number }>();
  for (const m of costlyMoves(games, usernames, key)) {
    const cur = byGame.get(m.c.game.id);
    if (!cur || m.lossPts > cur.loss) byGame.set(m.c.game.id, { c: m.c, plies: gamePlies(m.c)!, ply: m.ply, loss: m.lossPts });
  }
  return [...byGame.values()].sort(newestFirst);
}

/** The games that reached a repeated position (first time in each game, the player to move); null for an unknown key. */
function quickFixSlips(games: CachedGame[], usernames: string[], key: string): Slip[] | null {
  const named = new Set(usernames.map((u) => u.toLowerCase()));
  const mine = games.filter((c) => named.has(c.game.username.toLowerCase()));
  if (!findRepeated(mine).some((r) => r.key === key)) return null;
  const out: Slip[] = [];
  for (const { c, plies } of own(games, usernames)) {
    if (customStartFen(c.game.pgn)) continue; // as findRepeated: its count must match
    const p = plies.find((x) => x.mine && positionKey(x.fenBefore) === key);
    if (p) out.push({ c, plies, ply: p.ply });
  }
  return out.sort(newestFirst);
}

/** Up to `max` evenly spread ply indexes of `n`, always including `slip` (it replaces its nearest neighbour). */
function samplePlies(n: number, slip: number, max = TIMELINE_MAX_POINTS): { idx: number[]; slipIndex: number } {
  const idx =
    n <= max ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: max }, (_, i) => Math.round((i * (n - 1)) / (max - 1)));
  let slipIndex = 0;
  for (let i = 1; i < idx.length; i++) if (Math.abs(idx[i] - slip) < Math.abs(idx[slipIndex] - slip)) slipIndex = i;
  idx[slipIndex] = slip;
  return { idx, slipIndex };
}

/** One example, built field by field: the cache's best moves and lines and the opponent's name never get in. */
function row(s: Slip): ExampleRow {
  const { c, plies, ply } = s;
  const p = plies[ply];
  const forPlayer = (winWhite: number) => round1(c.game.myColor === 'white' ? winWhite : 100 - winWhite);
  const all = c.analysis.plies.map((x) => forPlayer(x.winPctWhite));
  const { idx, slipIndex } = samplePlies(all.length, ply);
  const m = new Chess(p.fenBefore).move(p.san);
  const rating = c.game.opponent?.rating;
  return {
    gameId: c.game.id,
    gameUrl: c.game.url ? c.game.url : null,
    date: new Date(c.game.endTime * 1000).toISOString().slice(0, 10),
    opponentRating: typeof rating === 'number' && Number.isFinite(rating) ? rating : null,
    result: c.game.outcome,
    myColor: c.game.myColor,
    slipPly: ply,
    slipMoveNo: Math.floor(ply / 2) + 1,
    fenBefore: p.fenBefore,
    playedSan: p.san,
    playedUci: m.from + m.to + (m.promotion ?? ''),
    quickWinBefore: round1(p.winBeforeMover),
    quickWinAfter: all[ply],
    timeline: idx.map((i) => all[i]),
    slipIndex,
  };
}

const TITLES: Record<'thrownWins' | 'quickFix', string> = {
  thrownWins: 'Games you were winning and lost',
  quickFix: 'Games that reached this position',
};

/** The page's title in plain words. */
export function examplesTitle(source: ExampleSource): string {
  return source === 'thrownWins' || source === 'quickFix' ? TITLES[source] : `${LEAK_LABELS[source]}: your costliest move in each game`;
}

/**
 * One page of examples for a source, from the named accounts' cached games. `limit` is clamped
 * to 1..EXAMPLES_MAX_LIMIT (default 10) and `offset` to 0 or more; `total` counts them all. An
 * unknown source, or a quick fix without a known position key, is an error (plain words).
 */
export function examplesPage(games: CachedGame[], usernames: string[], req: ExamplesRequest): ExamplesPage | { error: string } {
  const { source } = req;
  let slips: Slip[];
  if (source === 'thrownWins') {
    slips = thrownWins(games, usernames);
  } else if (source === 'quickFix') {
    const found = req.key ? quickFixSlips(games, usernames, req.key) : null;
    if (!found) {
      return {
        error: req.key
          ? 'No position you keep reaching has that key in these games. Use a quick fix key from coach_report.'
          : "A quick fix needs the position's key (from coach_report's quick fixes).",
      };
    }
    slips = found;
  } else if ((LEAK_KEYS as string[]).includes(source)) {
    slips = leakSlips(games, usernames, source);
  } else {
    return { error: `Unknown source "${String(source)}": use one of ${EXAMPLE_SOURCES.join(', ')}.` };
  }
  const limit = Math.min(EXAMPLES_MAX_LIMIT, Math.max(1, Math.floor(req.limit ?? EXAMPLES_MAX_LIMIT)));
  const offset = Math.max(0, Math.floor(req.offset ?? 0));
  const page: ExamplesPage = {
    kind: 'examples',
    source,
    title: examplesTitle(source),
    total: slips.length,
    offset,
    limit,
    numbersLabel: 'quick check',
    examples: slips.slice(offset, offset + limit).map(row),
  };
  if (source === 'quickFix' && req.key) page.key = req.key;
  return page;
}
