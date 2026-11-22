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

/**
 * One position the player keeps getting wrong, shown on the report card as a "mission": a
 * small board with their usual wrong move (red) and the best move (green).
 */
export interface ReportPosition {
  /** The position before the move, as a full FEN. */
  fen: string;
  /** The player's colour (the side to move here). */
  orientation: Color;
  /** The player's usual wrong moves here, most played first (1–4). */
  wrongSan: string[];
  /** The red arrow: the first of `wrongSan` as UCI, or null to draw no red arrow. */
  wrongUci: string | null;
  bestSan: string;
  bestUci: string;
  /** Average win-chance points lost each time the player went wrong here (0–100). */
  lossPts: number;
  /** In how many of the games that reached this position the player went wrong. */
  wrongTimes: number;
  /** How many of the player's games reached this position. */
  seenTimes: number;
  /** Opening name, e.g. "Caro-Kann Defense: Exchange Variation"; null if unknown. */
  opening: string | null;
  drillsDone: number;
  drillsTotal: number;
}

export interface ReportView {
  kind: 'report';
  headline: string;
  /** One plain sentence under the headline. */
  subhead?: string;
  games: number;
  timeClass: string;
  rows: ReportRow[];
  focus: string | null;
  /** This week's focus positions (at most MAX_REPORT_POSITIONS). */
  positions?: ReportPosition[];
  /** The training button's label; the widget defaults to DEFAULT_REPORT_CTA. */
  cta?: string;
}

export type CoachView =
  | ({ kind: 'answer' } & BoardView)
  | { kind: 'question'; fen: string; orientation: Color; gameId: string; ply: number; prompt: string }
  | ReportView;

/** What `toReportView` adds to the diagnosis: the words under the headline, the missions, the button. */
export interface ReportExtras {
  subhead?: string;
  positions?: ReportPosition[];
  cta?: string;
}

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
/** At most this many focus positions ("missions") a week. */
export const MAX_REPORT_POSITIONS = 3;
/** At most this many usual wrong moves per position. */
export const MAX_WRONG_MOVES = 4;
/** The longest training-button label the widget accepts. */
export const MAX_CTA_LENGTH = 60;
export const DEFAULT_REPORT_CTA = "Start this week's training";

const round1 = (x: number) => Math.round(x * 10) / 10;

/** A move the student tried on the question board (C1b's coach_check_move passes it in). */
export interface Attempt {
  moveSan: string;
  moveUci: string;
}

/**
 * The board for one position with the answer: the move shown as "your move" (red arrow)
 * against the best move (green), the best line to step through, and a caption with the win
 * chance. If the shown move is the best one, `bestUci`/`bestSan` are null and the widget draws
 * it in green.
 *
 * Without `attempt`, "your move" is the game move. With an `attempt` that differs from the game
 * move, "your move" is the attempt. The facts' win % and refutation belong to the game move,
 * so the caption tells them as the game move's and `winAfter` is null.
 */
export function toAnswerView(f: PositionFacts, attempt?: Attempt): CoachView {
  // A null best in the facts means the game move was the best move.
  const bestUci = f.bestUci ?? f.playedUci;
  const bestSan = f.bestSan ?? f.playedSan;
  const tried = attempt && attempt.moveUci !== f.playedUci ? attempt : null;
  const shownUci = tried ? tried.moveUci : f.playedUci;
  const shownSan = tried ? tried.moveSan : f.playedSan;
  const shownWasBest = shownUci === bestUci;
  const before = Math.round(f.winBefore);
  const after = Math.round(f.winAfter);

  const parts: string[] = [];
  if (tried) {
    parts.push(shownWasBest ? `${shownSan} is the best move here.` : `You tried ${shownSan}; the best move is ${bestSan}.`);
    parts.push(`In the game you played ${f.playedSan}: your win chance went from ${before}% to ${after}%.`);
  } else {
    const win = `Your win chance: ${before}% before this move, ${after}% after.`;
    parts.push(shownWasBest ? `${shownSan} was the best move here.` : `You played ${shownSan}; the best move was ${bestSan}.`, win);
    if (!shownWasBest && f.reason) parts.push(f.reason);
    if (!shownWasBest && f.refutationSan && f.refutationSan.length > 0) {
      parts.push(`After ${shownSan}, their strongest reply is ${f.refutationSan.slice(0, 3).join(' ')}.`);
    }
  }
  return {
    kind: 'answer',
    fen: f.fenBefore,
    orientation: f.mover,
    playedUci: shownUci,
    bestUci: shownWasBest ? null : bestUci,
    playedSan: shownSan,
    bestSan: shownWasBest ? null : bestSan,
    winBefore: f.winBefore,
    winAfter: tried ? null : f.winAfter,
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
 *
 * `extras` adds the sentence under the headline, up to three focus positions and the button
 * label. A position that `parseCoachView` would refuse is dropped here (the others stay), so
 * the widget never gets a report it can't show; the win-chance loss is rounded to 0.1.
 */
export function toReportView(d: DiagnosisLike, headline: string, extras: ReportExtras = {}): CoachView {
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

  const view: ReportView = { kind: 'report', headline, games: d.games, timeClass: d.timeClass, rows, focus };
  if (extras.subhead !== undefined) view.subhead = extras.subhead;
  if (extras.positions !== undefined) {
    view.positions = extras.positions
      .filter(isPosition)
      .slice(0, MAX_REPORT_POSITIONS)
      .map((p) => ({ ...p, wrongSan: [...p.wrongSan], lossPts: round1(p.lossPts) }));
  }
  if (extras.cta !== undefined) view.cta = extras.cta;
  return view;
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

const isCount = (x: unknown): x is number => isNum(x) && Number.isInteger(x) && x >= 0;

/** A UCI move such as "g8f6" or "e7e8q" (the same shape the board's arrows accept). */
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
/** A SAN move such as "Nf6", "exd5", "e8=Q+" or "O-O-O". */
const SAN = /^(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?$/;
/** Board, side to move, castling ("-" or a non-empty KQkq), en passant, optional move counters. */
const FEN_FIELDS = /^([pnbrqkPNBRQK1-8/]+) [wb] (?:-|(?=[KQkq])K?Q?k?q?) (?:-|[a-h][36])(?: \d{1,4} \d{1,4})?$/;

/** A FEN that looks legal: 8 ranks of 8 squares, a side to move, castling and en-passant fields. */
function isFen(x: unknown): x is string {
  if (!isStr(x) || x.length > 100) return false;
  const m = FEN_FIELDS.exec(x);
  if (!m) return false;
  const ranks = m[1].split('/');
  return (
    ranks.length === 8 &&
    ranks.every((r) => [...r].reduce((n, c) => n + (c >= '1' && c <= '8' ? Number(c) : 1), 0) === 8)
  );
}

function isPosition(p: unknown): p is ReportPosition {
  return (
    isObj(p) &&
    isFen(p.fen) &&
    isColor(p.orientation) &&
    Array.isArray(p.wrongSan) &&
    p.wrongSan.length >= 1 &&
    p.wrongSan.length <= MAX_WRONG_MOVES &&
    p.wrongSan.every((s) => isStr(s) && SAN.test(s)) &&
    (p.wrongUci === null || (isStr(p.wrongUci) && UCI.test(p.wrongUci))) &&
    isStr(p.bestSan) &&
    SAN.test(p.bestSan) &&
    isStr(p.bestUci) &&
    UCI.test(p.bestUci) &&
    isNum(p.lossPts) &&
    p.lossPts >= 0 &&
    p.lossPts <= 100 &&
    isCount(p.wrongTimes) &&
    isCount(p.seenTimes) &&
    p.seenTimes >= 1 &&
    p.wrongTimes <= p.seenTimes &&
    isStrOrNull(p.opening) &&
    isCount(p.drillsDone) &&
    isCount(p.drillsTotal) &&
    p.drillsDone <= p.drillsTotal
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
    isStrOrNull(v.focus) &&
    (v.subhead === undefined || isStr(v.subhead)) &&
    (v.positions === undefined ||
      (Array.isArray(v.positions) && v.positions.length <= MAX_REPORT_POSITIONS && v.positions.every(isPosition))) &&
    (v.cta === undefined || (isStr(v.cta) && v.cta.trim().length > 0 && v.cta.length <= MAX_CTA_LENGTH))
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
