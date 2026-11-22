/**
 * The positions the report card shows (up to three): positions the player keeps reaching and
 * keeps getting wrong, each with its usual wrong moves, the best move from a deep search, the
 * opening it comes from and the drills done on it. Built here; the report view takes them
 * once the redesigned report card lands.
 *
 * Only real mistakes are shown: a usual move counts as wrong only if the deep search agrees
 * it loses more than REPEAT_CFG.wrongLossPts, and a position with no such move is left out.
 */
import { evalToWinPct } from '../../../src/analysis/winPct';
import { uciLineToSan } from '../../../src/analysis/lines';
import type { Color } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { DISPLAY_CFG, REPEAT_CFG } from '../config';
import type { Diagnosis } from '../diagnosis/diagnose';
import type { RepeatedPosition } from '../diagnosis/repeated';
import type { DisplayEngine } from '../engine/displayEngine';
import { uciOf } from './explain';
import { DRILLS_PER_POSITION, moveOutcome, parseAttempt, rightSessionsByBoard } from './lesson';
import type { StudentFile } from './student';

export { DRILLS_PER_POSITION } from './lesson';

export interface ReportPosition {
  fen: string;
  orientation: Color;
  /** The player's usual wrong moves here (most frequent first), each confirmed wrong at depth. */
  wrongSan: string[];
  /** The first of `wrongSan` as UCI. */
  wrongUci: string | null;
  /** From the deep search, never the quick one. */
  bestSan: string;
  bestUci: string;
  /** Average win-% lost on the wrong moves shown, rounded (approximate: from the quick check). */
  lossPts: number;
  wrongTimes: number;
  seenTimes: number;
  opening: string | null;
  drillsDone: number;
  drillsTotal: number;
}

/** Positions on the report card. */
export const REPORT_POSITIONS = 3;
/** Repeated positions deep-checked at most (each takes a few seconds). */
const MAX_POSITIONS_CHECKED = 6;
/** Usual moves deep-checked per position. */
const MAX_MOVES_CHECKED = 3;

// ---- opening names ----

/** Chess.com's URL slugs drop the hyphen of these names. */
const HYPHENATED = new Set([
  'Caro-Kann', 'Nimzo-Indian', 'Bogo-Indian', 'Semi-Slav', 'Semi-Tarrasch', 'Smith-Morra', 'Mieses-Kotroc',
  'Nimzo-Larsen', 'Nimzowitsch-Larsen', 'Richter-Rauzer', 'Schliemann-Jaenisch', 'Hyper-Accelerated',
]);
/** ...and the apostrophe of these. */
const POSSESSIVE: Record<string, string> = {
  Queens: "Queen's", Kings: "King's", Bishops: "Bishop's", Petrovs: "Petrov's", Alekhines: "Alekhine's",
  Owens: "Owen's", Birds: "Bird's", Larsens: "Larsen's", Damianos: "Damiano's", Grobs: "Grob's",
};
/** The word that ends an opening's family name ("Caro-Kann Defense"), before its variation. */
const FAMILY_END = new Set(['Defense', 'Opening', 'Game', 'Gambit', 'Attack', 'System', 'Countergambit']);
const FAMILY_TAIL = new Set(['Accepted', 'Declined', 'Refused', 'Deferred']);

const header = (pgn: string, name: string) => new RegExp(`\\[${name} "([^"]*)"\\]`).exec(pgn)?.[1]?.trim() || null;

/** Drops a trailing move sequence ("…, 2...Nc6", "-3...cxd5-4.Bd3") and dangling punctuation. */
function withoutMoves(s: string, moveStart: RegExp): string {
  const m = moveStart.exec(s);
  return (m ? s.slice(0, m.index) : s).replace(/[\s,:;.-]+$/, '').replace(/\s+(with|and|of)$/i, '');
}

/** "Caro-Kann-Defense-Exchange-Variation" → "Caro-Kann Defense: Exchange Variation". */
function fromSlug(slug: string): string | null {
  // Moves start at "-3.", "...", or "-with-1-d4" (a move written without its dot).
  const raw = withoutMoves(slug, /-?\d+\.|\.\.\.|-with-\d/).split('-').filter(Boolean);
  const words: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const pair = `${raw[i]}-${raw[i + 1]}`;
    if (i + 1 < raw.length && HYPHENATED.has(pair)) {
      words.push(pair);
      i++;
    } else {
      words.push(POSSESSIVE[raw[i]] ?? raw[i]);
    }
  }
  if (words.length === 0) return null;
  let end = words.findIndex((w) => FAMILY_END.has(w));
  if (end >= 0 && FAMILY_TAIL.has(words[end + 1])) end++;
  if (end < 0 || end === words.length - 1) return words.join(' ');
  return `${words.slice(0, end + 1).join(' ')}: ${words.slice(end + 1).join(' ')}`;
}

/**
 * A readable opening name from a game's PGN headers: the `[Opening]` header when there is one,
 * else Chess.com's `[ECOUrl]` turned into words, without any move sequence. Null when neither
 * names an opening.
 */
export function openingName(pgn: string): string | null {
  const opening = header(pgn, 'Opening');
  if (opening) return withoutMoves(opening, /\s\d+\.|\.\.\./) || null;
  const url = header(pgn, 'ECOUrl');
  const slug = url ? /\/openings\/([^?#]+)/.exec(url)?.[1] : undefined;
  if (!slug) return null;
  try {
    return fromSlug(decodeURIComponent(slug));
  } catch {
    return null;
  }
}

/**
 * One name for a position reached in several games: the most common opening family (the part
 * before ":"; ties go to the first seen), named as far as all its games agree, word by word.
 */
export function commonOpening(names: string[]): string | null {
  if (names.length === 0) return null;
  const family = (n: string) => n.split(':')[0].trim();
  const counts = new Map<string, number>();
  for (const n of names) counts.set(family(n), (counts.get(family(n)) ?? 0) + 1);
  let top = family(names[0]);
  for (const [f, k] of counts) if (k > counts.get(top)!) top = f;
  const same = names.filter((n) => family(n) === top).map((n) => n.split(' '));
  const prefix: string[] = [];
  for (let i = 0; same.every((w) => w[i] !== undefined && w[i] === same[0][i]); i++) prefix.push(same[0][i]);
  const agreed = prefix.join(' ').replace(/[\s,:;]+$/, '');
  return agreed.length > top.length ? agreed : top;
}

function openingOf(r: RepeatedPosition, byId: Map<string, CachedGame>): string | null {
  const names = r.gameIds
    .map((id) => byId.get(id)?.game.pgn)
    .map((pgn) => (pgn ? openingName(pgn) : null))
    .filter((n): n is string => n !== null);
  return commonOpening(names);
}

// ---- the positions ----

/**
 * Up to REPORT_POSITIONS repeated positions for the report card, the focus positions first.
 * Each is searched at display depth: the best move comes from that search, and each usual
 * wrong move (at most MAX_MOVES_CHECKED) is kept only if the search after it loses more than
 * REPEAT_CFG.wrongLossPts against the best. A position with no such move is left out.
 * `wrongTimes` and `lossPts` count only the wrong moves shown. `drillsDone` counts the sessions
 * in the student file with a right answer at that board (default 0).
 */
export async function buildReportPositions(
  d: Diagnosis,
  games: CachedGame[],
  displayEngine: DisplayEngine,
  student?: StudentFile,
): Promise<ReportPosition[]> {
  const focusKeys = d.focus?.kind === 'repeated' ? d.focus.keys : [];
  const ordered = [
    ...focusKeys.flatMap((k) => d.repeated.filter((r) => r.key === k)),
    ...d.repeated.filter((r) => !focusKeys.includes(r.key)),
  ];
  const byId = new Map(games.map((c) => [c.game.id, c]));
  const drilled = rightSessionsByBoard(student, byId);

  const out: ReportPosition[] = [];
  for (const r of ordered.slice(0, MAX_POSITIONS_CHECKED)) {
    if (out.length >= REPORT_POSITIONS) break;
    const before = await displayEngine.evaluate(r.fen, DISPLAY_CFG.movetimeMs);
    const bestUci = before.bestMoveUci ?? before.pvUci?.[0] ?? null;
    const bestSan = bestUci ? (uciLineToSan(r.fen, [bestUci])?.[0] ?? null) : null;
    if (!bestUci || !bestSan) continue;
    const bestWin = evalToWinPct(before.cp, before.mate);

    const wrong: { san: string; uci: string; times: number; lossPts: number }[] = [];
    let checked = 0;
    for (const u of r.usual) {
      if (checked >= MAX_MOVES_CHECKED) break;
      const m = parseAttempt(r.fen, u.move);
      if (!m || uciOf(m) === bestUci) continue; // the deep best is never "wrong"
      checked++;
      const { win } = await moveOutcome(m, displayEngine);
      if (bestWin - win > REPEAT_CFG.wrongLossPts) wrong.push({ san: m.san, uci: uciOf(m), times: u.times, lossPts: u.lossPts });
    }
    if (wrong.length === 0) continue;
    // The counts describe the wrong moves shown, so a move the deep check cleared isn't counted.
    const wrongTimes = wrong.reduce((n, w) => n + w.times, 0);
    const avgLoss = wrong.reduce((n, w) => n + w.times * w.lossPts, 0) / wrongTimes;

    out.push({
      fen: r.fen,
      orientation: r.fen.split(' ')[1] === 'w' ? 'white' : 'black',
      wrongSan: wrong.map((w) => w.san),
      wrongUci: wrong[0].uci,
      bestSan,
      bestUci,
      lossPts: Math.round(avgLoss),
      wrongTimes,
      seenTimes: r.seen,
      opening: openingOf(r, byId),
      drillsDone: Math.min(DRILLS_PER_POSITION, drilled.get(r.key)?.size ?? 0),
      drillsTotal: DRILLS_PER_POSITION,
    });
  }
  return out;
}
