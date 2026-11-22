/**
 * The three things the board widget can show, and pure mappers that build them from the
 * coach's data. Every tool linked to BOARD_URI returns one CoachView as `structuredContent`;
 * the widget switches on `kind`.
 *
 * No runtime imports from node: the widget bundles this file for `parseCoachView`.
 */
import type { Color } from '../../../src/types';
import type { PositionFacts } from '../coaching/positionFacts';
import type { BoardView } from './boardResource';

export type ReportLabel = 'gap' | 'notYourProblem' | 'noClearDifference' | 'notEnoughData';

export interface ReportRow {
  /** Plain-English name of the area, e.g. "Endgames". */
  area: string;
  label: ReportLabel;
  /** % of the player's moves in this area that were serious mistakes (mistake or blunder). */
  you: number | null;
  /** The same % for players at their rating (the opponents in the same games). */
  them: number | null;
  /** Where the player's own % likely lies, on the same scale as `you`. */
  range: [number, number] | null;
  games: number;
}

export type CoachView =
  | ({ kind: 'answer' } & BoardView)
  | { kind: 'question'; fen: string; orientation: Color; gameId: string; ply: number; prompt: string }
  | { kind: 'report'; headline: string; games: number; timeClass: string; rows: ReportRow[]; focus: string | null };

/**
 * The fields of B4's `Diagnosis` that the report card reads. Declared here structurally so
 * the widget branch doesn't depend on the diagnosis code; a real `Diagnosis` is assignable.
 */
export interface DiagnosisLike {
  timeClass: string;
  games: number;
  areas: {
    area: string;
    label: ReportLabel;
    myRate: number; // % of moves that were mistake or blunder
    oppRate: number;
    gapPts: number; // myRate − oppRate
    ci95: [number, number]; // range of the gap, percentage points
    ciAdj?: [number, number]; // the adjusted range that decides `gap`; preferred when present
    games: number;
  }[];
  focus: { kind: 'area'; area: string } | { kind: 'repeated'; keys: string[] } | null;
}

/** The report card never shows more rows than this (spec §6b: keep it simple). */
export const MAX_REPORT_ROWS = 6;

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * The board for one position with the answer: the played move (red arrow) against the best
 * move (green), the best line to step through, and a caption with the win chance before and
 * after. If the played move was the best one, `bestUci`/`bestSan` are null and the widget
 * draws the played move in green.
 */
export function toAnswerView(f: PositionFacts): CoachView {
  const playedWasBest = f.bestUci === null || f.bestUci === f.playedUci;
  const win = `Your win chance: ${Math.round(f.winBefore)}% before this move, ${Math.round(f.winAfter)}% after.`;
  const parts = playedWasBest
    ? [`${f.playedSan} was the best move here.`, win]
    : [`You played ${f.playedSan}; the best move was ${f.bestSan ?? f.bestUci}.`, win];
  if (!playedWasBest && f.reason) parts.push(f.reason);
  if (!playedWasBest && f.refutationSan && f.refutationSan.length > 0) {
    parts.push(`After ${f.playedSan}, their strongest reply is ${f.refutationSan.slice(0, 3).join(' ')}.`);
  }
  return {
    kind: 'answer',
    fen: f.fenBefore,
    orientation: f.mover,
    playedUci: f.playedUci,
    bestUci: playedWasBest ? null : f.bestUci,
    playedSan: f.playedSan,
    bestSan: playedWasBest ? null : f.bestSan,
    winBefore: f.winBefore,
    winAfter: f.winAfter,
    bestLineSan: f.bestLineSan,
    caption: parts.join(' '),
  };
}

/**
 * The same position as a question: the board before the move, nothing else. Built from an
 * explicit list of fields so that no part of the answer (moves, lines, win %, reason) can
 * slip through.
 */
export function toQuestionView(f: PositionFacts, prompt: string): CoachView {
  return { kind: 'question', fen: f.fenBefore, orientation: f.mover, gameId: f.gameId, ply: f.ply, prompt };
}

const AREA_NAMES: Record<string, string> = {
  opening: 'Openings',
  middlegame: 'Middlegames',
  endgame: 'Endgames',
  converting: "When you're ahead",
  defending: "When you're behind",
  timePressure: 'Low on the clock',
};

const AREA_FOCUS: Record<string, string> = {
  opening: 'your openings',
  middlegame: 'your middlegames',
  endgame: 'your endgames',
  converting: "finishing off games when you're ahead",
  defending: "holding on when you're behind",
  timePressure: "your moves when you're low on the clock",
};

/** "rookEndgames" → "Rook endgames", for an area key without a hand-written name. */
function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const LABEL_ORDER: Record<ReportLabel, number> = { gap: 0, notYourProblem: 1, noClearDifference: 2, notEnoughData: 3 };

/**
 * The report card: at most six areas in plain words, the player's serious-mistake rate
 * against players at their rating with the likely range, and the week's focus.
 *
 * Rows are ordered gap first (the surest gap first), then "not a weak spot", "too close to
 * call" and "not enough games", so the row cap only ever drops the least informative rows.
 * The likely range is the gap's range moved onto the player's own rate (them + range), so
 * a gap row's band sits wholly above the "them" mark. Rows with too few games show no
 * numbers at all.
 */
export function toReportView(d: DiagnosisLike, headline: string): CoachView {
  const lowEnd = (a: DiagnosisLike['areas'][number]) => (a.ciAdj ?? a.ci95)[0];
  const sorted = d.areas
    .map((a, i) => ({ a, i }))
    .sort(
      (x, y) =>
        LABEL_ORDER[x.a.label] - LABEL_ORDER[y.a.label] ||
        (x.a.label === 'gap' ? lowEnd(y.a) - lowEnd(x.a) : 0) ||
        x.i - y.i,
    )
    .slice(0, MAX_REPORT_ROWS);

  const rows: ReportRow[] = sorted.map(({ a }) => {
    const name = AREA_NAMES[a.area] ?? humanize(a.area);
    if (a.label === 'notEnoughData') {
      return { area: name, label: a.label, you: null, them: null, range: null, games: a.games };
    }
    const [lo, hi] = a.ciAdj ?? a.ci95;
    return {
      area: name,
      label: a.label,
      you: round1(a.myRate),
      them: round1(a.oppRate),
      range: [round1(Math.max(0, a.oppRate + lo)), round1(Math.max(0, a.oppRate + hi))],
      games: a.games,
    };
  });

  let focus: string | null = null;
  if (d.focus?.kind === 'area') {
    focus = AREA_FOCUS[d.focus.area] ?? humanize(d.focus.area).toLowerCase();
  } else if (d.focus?.kind === 'repeated') {
    const n = d.focus.keys.length;
    focus = n === 1 ? 'the position you keep getting wrong' : `the ${n} positions you keep getting wrong`;
  }

  return { kind: 'report', headline, games: d.games, timeClass: d.timeClass, rows, focus };
}

// ---- Checking what a tool sent (used by the widget) ----

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStrOrNull = (x: unknown) => x === null || isStr(x);
const isNumOrNull = (x: unknown) => x === null || isNum(x);
const isColor = (x: unknown): x is Color => x === 'white' || x === 'black';
const isLabel = (x: unknown): x is ReportLabel => isStr(x) && Object.hasOwn(LABEL_ORDER, x);

function isAnswer(v: Obj): boolean {
  return (
    isStr(v.fen) &&
    isColor(v.orientation) &&
    isStrOrNull(v.playedUci) &&
    isStrOrNull(v.bestUci) &&
    isStrOrNull(v.playedSan) &&
    isStrOrNull(v.bestSan) &&
    isNumOrNull(v.winBefore) &&
    isNumOrNull(v.winAfter) &&
    (v.bestLineSan === null || (Array.isArray(v.bestLineSan) && v.bestLineSan.every(isStr))) &&
    isStr(v.caption)
  );
}

function isQuestion(v: Obj): boolean {
  return isStr(v.fen) && isColor(v.orientation) && isStr(v.gameId) && isNum(v.ply) && isStr(v.prompt);
}

function isRow(r: unknown): boolean {
  return (
    isObj(r) &&
    isStr(r.area) &&
    isLabel(r.label) &&
    isNumOrNull(r.you) &&
    isNumOrNull(r.them) &&
    (r.range === null || (Array.isArray(r.range) && r.range.length === 2 && r.range.every(isNum))) &&
    isNum(r.games)
  );
}

function isReport(v: Obj): boolean {
  return (
    isStr(v.headline) &&
    isNum(v.games) &&
    isStr(v.timeClass) &&
    Array.isArray(v.rows) &&
    v.rows.length <= MAX_REPORT_ROWS &&
    v.rows.every(isRow) &&
    isStrOrNull(v.focus)
  );
}

/** Checks a tool result's `structuredContent`; returns null unless it is a well-formed CoachView. */
export function parseCoachView(x: unknown): CoachView | null {
  if (!isObj(x)) return null;
  const ok =
    (x.kind === 'answer' && isAnswer(x)) ||
    (x.kind === 'question' && isQuestion(x)) ||
    (x.kind === 'report' && isReport(x));
  return ok ? (x as unknown as CoachView) : null;
}
