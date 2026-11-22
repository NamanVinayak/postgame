/**
 * The positions the report card shows as missions (up to three): positions the player keeps
 * reaching and keeps getting wrong, each with its usual wrong moves, the best move from a deep
 * search, the opening it comes from and the drills done on it.
 *
 * The same gate as practice questions for a repeated position: a usual move counts as wrong
 * only if the deep search agrees it loses more than REPEAT_CFG.wrongLossPts and it isn't the
 * deep best move; a position with no such move is left out. The loss shown is the deep one.
 */
import { evalToWinPct } from '../../../src/analysis/winPct';
import { uciLineToSan } from '../../../src/analysis/lines';
import type { CachedGame } from '../analysis/cache';
import { DISPLAY_CFG, REPEAT_CFG } from '../config';
import type { Diagnosis } from '../diagnosis/diagnose';
import type { RepeatedPosition } from '../diagnosis/repeated';
import type { DisplayEngine } from '../engine/displayEngine';
import type { ReportPosition } from '../server/views';
import { uciOf } from './explain';
import { DRILLS_PER_POSITION, moveOutcome, parseAttempt, rightSessionsByBoard } from './lesson';
import { commonOpening, openingName } from './openings';
import type { SearchBudget } from './searchBudget';
import type { StudentFile } from './student';

export type { ReportPosition } from '../server/views';
export { DRILLS_PER_POSITION } from './lesson';
export { commonOpening, openingName } from './openings';

/** Positions on the report card. */
export const REPORT_POSITIONS = 3;
/** Repeated positions deep-checked at most (each takes a few seconds). */
const MAX_POSITIONS_CHECKED = 6;
/** Usual moves deep-checked per position. */
const MAX_MOVES_CHECKED = 3;

function openingOf(r: RepeatedPosition, byId: Map<string, CachedGame>): string | null {
  const names = r.gameIds
    .map((id) => byId.get(id)?.game.pgn)
    .map((pgn) => (pgn ? openingName(pgn) : null))
    .filter((n): n is string => n !== null);
  return commonOpening(names);
}

/**
 * Up to REPORT_POSITIONS repeated positions for the report card, the focus positions first.
 * Each is searched at display depth: the best move comes from that search, and each usual
 * wrong move (at most MAX_MOVES_CHECKED) is kept only if the search after it loses more than
 * REPEAT_CFG.wrongLossPts against the best. A position with no such move is left out.
 * `wrongTimes` counts the wrong moves shown; `lossPts` is their deep loss, averaged over the
 * times each was played. `drillsDone` counts the sessions in the student file whose first try
 * at that board was right (default 0).
 *
 * `opts.skip` leaves out boards (position keys) the caller shows elsewhere, and the next
 * positions take their place. With `opts.budget`, a search starts only while the budget allows
 * one more; when it runs out, the positions ready so far are returned (`budget.ranOut` says so).
 */
export async function buildReportPositions(
  d: Diagnosis,
  games: CachedGame[],
  displayEngine: DisplayEngine,
  student?: StudentFile,
  opts: { skip?: Set<string>; budget?: SearchBudget } = {},
): Promise<ReportPosition[]> {
  const focusKeys = d.focus?.kind === 'repeated' ? d.focus.keys : [];
  const ordered = [
    ...focusKeys.flatMap((k) => d.repeated.filter((r) => r.key === k)),
    ...d.repeated.filter((r) => !focusKeys.includes(r.key)),
  ];
  const byId = new Map(games.map((c) => [c.game.id, c]));
  const drilled = rightSessionsByBoard(student, byId);

  const out: ReportPosition[] = [];
  const affordable = () => !opts.budget || opts.budget.canSpend(1);
  for (const r of ordered.filter((x) => !opts.skip?.has(x.key)).slice(0, MAX_POSITIONS_CHECKED)) {
    if (out.length >= REPORT_POSITIONS) break;
    if (!affordable()) break;
    const before = await displayEngine.evaluate(r.fen, DISPLAY_CFG.movetimeMs);
    const bestUci = before.bestMoveUci ?? before.pvUci?.[0] ?? null;
    const bestSan = bestUci ? (uciLineToSan(r.fen, [bestUci])?.[0] ?? null) : null;
    if (!bestUci || !bestSan) continue;
    const bestWin = evalToWinPct(before.cp, before.mate);

    const wrong: { san: string; uci: string; times: number; deepLoss: number }[] = [];
    let checked = 0;
    let cut = false;
    for (const u of r.usual) {
      if (checked >= MAX_MOVES_CHECKED) break;
      const m = parseAttempt(r.fen, u.move);
      if (!m || uciOf(m) === bestUci) continue; // the deep best is never "wrong"
      if (!affordable()) {
        cut = true;
        break;
      }
      checked++;
      const { win } = await moveOutcome(m, displayEngine);
      const deepLoss = Math.max(0, bestWin - win);
      if (deepLoss > REPEAT_CFG.wrongLossPts) wrong.push({ san: m.san, uci: uciOf(m), times: u.times, deepLoss });
    }
    // A position whose moves weren't all checked waits for the next call (its numbers would be partial).
    if (cut) break;
    if (wrong.length === 0) continue;
    // The numbers describe the wrong moves shown, so a move the deep check cleared isn't counted.
    const wrongTimes = wrong.reduce((n, w) => n + w.times, 0);
    const lossPts = wrong.reduce((n, w) => n + w.times * w.deepLoss, 0) / wrongTimes;

    out.push({
      fen: r.fen,
      orientation: r.fen.split(' ')[1] === 'w' ? 'white' : 'black',
      wrongSan: wrong.map((w) => w.san),
      wrongUci: wrong[0].uci,
      bestSan,
      bestUci,
      lossPts: Math.round(lossPts * 10) / 10,
      wrongTimes,
      seenTimes: Math.max(r.seen, wrongTimes),
      opening: openingOf(r, byId),
      drillsDone: Math.min(DRILLS_PER_POSITION, drilled.get(r.key)?.size ?? 0),
      drillsTotal: DRILLS_PER_POSITION,
    });
  }
  return out;
}
