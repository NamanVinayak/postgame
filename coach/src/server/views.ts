/**
 * The four things the board widget can show, and pure mappers that build them from the
 * coach's data. Every tool linked to BOARD_URI returns one CoachView as `structuredContent`;
 * the widget switches on `kind`.
 *
 * The report card is v4 (spec §6c, "Where your points go"). The v3 report (areas against
 * players at your rating) is still emitted by the deprecated `toReportView(d, headline, …)`
 * overload, because tools.ts and its tests pin that shape until P3 rewires them;
 * `parseCoachView` turns such a report into a v4 view for the widget. P3 removes the legacy
 * overload, the Legacy* types and the parser's legacy branch.
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

/**
 * @deprecated The v3 report card (areas against players at your rating). Still what the old
 * `toReportView(d, headline, extras)` returns for tools.ts until P3; the widget shows it as v4.
 */
export interface LegacyReportView {
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

/** The big plain sentence at the top of the card, and one line under it. */
export interface ReportHero {
  headline: string;
  sub: string;
}

/** One bar of "Where your points go": a share of everything the player gave away. */
export interface ReportLeak {
  /** Plain name, e.g. "Balanced middlegames". */
  label: string;
  /** Share of all the win chance the player gave away that went here, whole %. */
  sharePct: number;
  /** Where that share likely lies (from resampling whole games), whole %. */
  range: [number, number];
  /** One plain line, e.g. "about 1.8 big mistakes a game"; may be empty. */
  detail: string;
}

/** A board for this week's lesson. It carries no answer: no best move, no played move. */
export interface FocusPosition {
  fen: string;
  orientation: Color;
  prompt: string;
}

/** "This week": the one thing to train, its boards (no answers) and the drill count. */
export interface ReportFocus {
  title: string;
  line: string;
  /** e.g. "About +55 rating points if you halve them (rough estimate)". */
  estimate?: string;
  positions: FocusPosition[];
  drillsDone: number;
  drillsTotal: number;
}

/** A position the player keeps reaching and getting wrong. Its answer stays hidden until revealed. */
export interface QuickFix {
  fen: string;
  orientation: Color;
  /** e.g. the opening name. */
  label: string;
  /** e.g. "8 of 9 games". */
  times: string;
  /** The player's usual wrong moves (1–4); the first is drawn as a red arrow when wrongUci is set. */
  wrongSan: string[];
  wrongUci: string | null;
  /** True once the player has tried this board; only then are bestSan and bestUci filled in. */
  revealed: boolean;
  bestSan: string | null;
  bestUci: string | null;
}

/** The report card, v4 (spec §6c). */
export interface ReportView {
  kind: 'report';
  games: number;
  timeClass: string;
  hero: ReportHero;
  /** At most MAX_REPORT_LEAKS, largest share first. */
  leaks: ReportLeak[];
  /** One muted line of context. */
  context?: string;
  focus: ReportFocus;
  /** At most MAX_QUICK_FIXES. */
  quickFixes?: QuickFix[];
  /** False when there are too few games to say how sure the shares are: the bars then show no ranges. */
  rangesReliable?: boolean;
  /** The training button's label; the widget defaults to DEFAULT_REPORT_CTA. */
  cta?: string;
}

/** How far a long job has got, e.g. 312 of 900 games analysed. */
export interface StatusProgress {
  done: number;
  total: number;
}

/** A calm waiting card while the coach works (fetching or analysing games). */
export interface StatusView {
  kind: 'status';
  title: string;
  message: string;
  progress?: StatusProgress;
}

export type CoachView =
  | ({ kind: 'answer' } & BoardView)
  | { kind: 'question'; fen: string; orientation: Color; gameId: string; ply: number; prompt: string }
  | ReportView
  | StatusView;

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

/**
 * The fields of P1's `LeakReport` that the v4 card reads, declared structurally (like
 * DiagnosisLike) so this file doesn't import the diagnosis code; a real LeakReport is assignable.
 */
export interface LeakReportLike {
  timeClass: string;
  games: number;
  /** Largest share first (the mapper sorts again to be sure). */
  leaks: { key: string; label: string; sharePct: number; shareRange: [number, number]; bigMistakesPerGame: number }[];
  conversion: {
    winningGames: number;
    lost: number;
    convertedPct: number;
    lostShareOfLossesPct: number;
    oppConvertedPct: number;
  };
  timeLosses: { losses: number; onTime: number; sharePct: number };
  whatIf: { ratingPoints: number } | null;
  focus: { kind: 'keepTheWin' } | { kind: 'clock' } | { kind: 'leak'; key: string };
  /** False when the shares' ranges can't be trusted (too few games); passed to the card as is. */
  rangesReliable?: boolean;
}

/** A lesson board as the server knows it. Any extra fields (answers) are dropped by the mapper. */
export interface FocusPositionInput {
  fen: string;
  orientation: Color;
  prompt?: string;
}

/** What `toReportView` adds to a LeakReportLike: the lesson's boards, its drill count, quick fixes, the button. */
export interface ReportV4Extras {
  positions?: FocusPositionInput[];
  drillsDone?: number;
  /** Defaults to DRILLS_PER_WEEK. */
  drillsTotal?: number;
  quickFixes?: QuickFix[];
  /** Replaces the context line the mapper writes. */
  context?: string;
  cta?: string;
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
/** The longest title or message a status card accepts. */
export const MAX_STATUS_TEXT = 300;
/** The v4 card shows at most this many bars, at most this many lesson boards and quick fixes. */
export const MAX_REPORT_LEAKS = 6;
export const MAX_FOCUS_POSITIONS = 3;
export const MAX_QUICK_FIXES = 3;
/** The weekly drill target (P1's LEAK_CFG.drillsPerWeek; config.ts can't be imported here). */
export const DRILLS_PER_WEEK = 20;
export const KEEP_THE_WIN_PROMPT = "You're winning here. Find the move that keeps it.";
const MAX_HERO_TEXT = 200;
const MAX_LINE_TEXT = 200;
const MAX_LABEL_TEXT = 80;
const MAX_DETAIL_TEXT = 120;
const MAX_CONTEXT_TEXT = 300;
const MAX_TIMES_TEXT = 60;
const MAX_TIME_CLASS = 40;

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
 * the widget never gets a report it can't show; the same goes for a button label that is
 * empty or too long (it is left out and the widget's default applies). The win-chance loss is
 * rounded to 0.1.
 */
function legacyReportView(d: DiagnosisLike, headline: string, extras: ReportExtras): LegacyReportView {
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

  const view: LegacyReportView = { kind: 'report', headline, games: d.games, timeClass: d.timeClass, rows, focus };
  if (extras.subhead !== undefined) view.subhead = extras.subhead;
  if (extras.positions !== undefined) {
    view.positions = extras.positions
      .filter(isPosition)
      .slice(0, MAX_REPORT_POSITIONS)
      .map((p) => ({ ...p, wrongSan: [...p.wrongSan], lossPts: round1(p.lossPts) }));
  }
  if (isCta(extras.cta)) view.cta = extras.cta; // otherwise the widget's default label applies
  return view;
}

/**
 * The report card v4 (spec §6c) from a leak report: the hero sentence, the ranked bars of where
 * the points go, one context line, this week's lesson (boards with no answers, the drill count
 * and, for "Keep the win", the rough what-if), quick fixes with hidden answers, and the button.
 * See reportV4 for the rules.
 */
export function toReportView(r: LeakReportLike, extras?: ReportV4Extras): ReportView;
/**
 * @deprecated The v3 card for tools.ts until P3 rewires it: at most six areas in plain words,
 * the player's serious-mistake rate against players at their rating with the likely range,
 * and the week's focus (see legacyReportView). The widget shows it as a minimal v4 card.
 */
export function toReportView(d: DiagnosisLike, headline: string, extras?: ReportExtras): LegacyReportView;
export function toReportView(
  a: LeakReportLike | DiagnosisLike,
  b?: string | ReportV4Extras,
  c?: ReportExtras,
): ReportView | LegacyReportView {
  if (typeof b === 'string') return legacyReportView(a as DiagnosisLike, b, c ?? {});
  return reportV4(a as LeakReportLike, b ?? {});
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * "1 in N" from a share in %: N is 100 ÷ the share, rounded, and never below 2 (so a share of
 * 60–85% reads "1 in 2", which understates rather than overstates). Above 85% it is "almost
 * all", and a share of zero is "none".
 */
function oneInN(sharePct: number): number | 'none' | 'almostAll' {
  if (!(sharePct > 0)) return 'none';
  if (sharePct > 85) return 'almostAll';
  return Math.max(2, Math.round(100 / sharePct));
}

/**
 * The hero for "Keep the win": "You were winning in 493 games, and lost 142 of them." and
 * "1 in 3 of your losses were games you were winning." (see oneInN).
 */
export function heroFromConversion(c: Pick<LeakReportLike['conversion'], 'winningGames' | 'lost' | 'lostShareOfLossesPct'>): ReportHero {
  const headline = `You were winning in ${plural(c.winningGames, 'game')}, and lost ${c.lost} of them.`;
  const n = oneInN(c.lostShareOfLossesPct);
  const sub =
    n === 'none'
      ? 'None of your losses were games you were winning.'
      : n === 'almostAll'
        ? 'Almost all of your losses were games you were winning.'
        : `1 in ${n} of your losses were games you were winning.`;
  return { headline, sub };
}

/** "72 of your 448 losses were on time", "1 of your 1 loss was on time". */
const onTimeText = (t: LeakReportLike['timeLosses']) =>
  `${t.onTime} of your ${plural(t.losses, 'loss', 'losses')} ${t.onTime === 1 ? 'was' : 'were'} on time`;

/** The hero for "the clock": how many losses were on time (see oneInN). */
export function heroFromTimeLosses(t: LeakReportLike['timeLosses']): ReportHero {
  const n = oneInN(t.sharePct);
  const sub =
    n === 'none'
      ? 'None of your losses were on time.'
      : n === 'almostAll'
        ? 'Almost all of your losses were on time.'
        : `1 in ${n} of your losses came from the clock, not the board.`;
  return { headline: `${onTimeText(t)}.`, sub };
}

/**
 * Costly moves (a mistake or blunder: the win chance drops by 10 points or more) in natural
 * numbers: "About 2 costly moves per game" (1.5 or more a game, rounded), "About 1 costly move
 * per game" (0.75 to 1.5), "About 1 costly move every 2 games" (0.3 to 0.75), "About 1 costly
 * move every 5 games" (under 0.3: every round(1 ÷ x) games).
 */
export function costlyMovesText(perGame: number): string {
  if (!(perGame > 0)) return 'No costly moves here';
  if (perGame >= 1.5) return `About ${Math.round(perGame)} costly moves per game`;
  if (perGame >= 0.75) return 'About 1 costly move per game';
  if (perGame >= 0.3) return 'About 1 costly move every 2 games';
  return `About 1 costly move every ${Math.round(1 / perGame)} games`;
}

/**
 * The hero for a single situation. A share is a leak, not a majority: "Your biggest leak: X."
 * when it is the top bar, "Your focus this week: X." when it isn't; then its share.
 */
function heroFromLeak(leak: LeakReportLike['leaks'][number] | undefined, isTop: boolean): ReportHero {
  if (!leak) return { headline: 'Not enough games yet to say where your points go.', sub: '' };
  const name = `${leak.label.charAt(0).toLowerCase()}${leak.label.slice(1)}`;
  return {
    headline: isTop ? `Your biggest leak: ${name}.` : `Your focus this week: ${name}.`,
    sub: `${Math.round(leak.sharePct)}% of the win chance you give away happens here.`,
  };
}

/** The context line for "Keep the win": how the opponents keep their own winning games. */
function conversionContext(c: LeakReportLike['conversion']): string {
  const you = Math.round(c.convertedPct);
  const opp = Math.round(c.oppConvertedPct);
  if (opp === you) {
    return `Your opponents keep the same share of their winning games as you (${opp}%): normal at your level, and the biggest thing you control.`;
  }
  if (Math.abs(opp - you) <= 5) {
    return `Your opponents keep about the same share of their winning games (${opp}%; you ${you}%): normal at your level, and the biggest thing you control.`;
  }
  return opp > you
    ? `Your opponents keep more of their winning games (${opp}%; you ${you}%), so this is the biggest thing you control.`
    : `Your opponents keep fewer of their winning games (${opp}%; you ${you}%); even so, it's the biggest thing you control.`;
}

const round5 = (x: number) => Math.round(x / 5) * 5;

/** A quick fix from a repeated position (P3 and the legacy card use it). The answer is kept only once revealed. */
export function quickFixFromPosition(p: ReportPosition, revealed: boolean): QuickFix {
  return {
    fen: p.fen,
    orientation: p.orientation,
    label: p.opening ?? 'A position you keep reaching',
    times: `${p.wrongTimes} of ${plural(p.seenTimes, 'game')}`,
    wrongSan: [...p.wrongSan],
    wrongUci: p.wrongUci,
    revealed,
    bestSan: revealed ? p.bestSan : null,
    bestUci: revealed ? p.bestUci : null,
  };
}

/** A quick fix rebuilt from an explicit list of fields, with the answer blanked unless revealed. */
function cleanQuickFix(q: QuickFix): QuickFix {
  return {
    fen: q.fen,
    orientation: q.orientation,
    label: q.label,
    times: q.times,
    wrongSan: Array.isArray(q.wrongSan) ? [...q.wrongSan] : q.wrongSan,
    wrongUci: q.wrongUci,
    revealed: q.revealed,
    bestSan: q.revealed === true ? q.bestSan : null,
    bestUci: q.revealed === true ? q.bestUci : null,
  };
}

/**
 * Builds the v4 card. Rules:
 * - Hero: "Keep the win" uses the conversion; "the clock" the time losses; a single situation
 *   its own share and big mistakes a game.
 * - Bars: largest share first, at most six, whole %; the range is rounded and kept within
 *   0–100. Each bar's line: the clock's is "72 of your 448 losses were on time"; the others
 *   give big mistakes a game ("big mistakes" spelled out on the first only).
 * - Context: for "Keep the win", how the opponents keep their own winning games, worked out
 *   from both conversion rates. extras.context replaces it.
 * - Lesson boards: rebuilt from fen, orientation and prompt only, so no answer can ride along.
 *   Bad boards are dropped; at most three.
 * - Estimate: only for "Keep the win" with a what-if, rounded to 5, and only when positive.
 * - Quick fixes: rebuilt from an explicit list of fields, the answer blanked unless revealed.
 *   Bad ones are dropped; at most three.
 * Like the other mappers, it never emits what parseCoachView would refuse.
 */
function reportV4(r: LeakReportLike, x: ReportV4Extras): ReportView {
  const ranked = [...r.leaks].sort((p, q) => q.sharePct - p.sharePct).slice(0, MAX_REPORT_LEAKS);
  const leaks: ReportLeak[] = ranked.map((l) => {
    let detail = '';
    if (l.key === 'clock' && r.timeLosses.losses > 0) detail = onTimeText(r.timeLosses);
    else if (Number.isFinite(l.bigMistakesPerGame) && l.bigMistakesPerGame >= 0) detail = costlyMovesText(l.bigMistakesPerGame);
    const clamp = (v: number) => Math.min(100, Math.max(0, Math.round(v)));
    const lo = clamp(Math.min(l.shareRange[0], l.shareRange[1]));
    const hi = clamp(Math.max(l.shareRange[0], l.shareRange[1]));
    return { label: l.label, sharePct: clamp(l.sharePct), range: [lo, hi], detail };
  });

  const f = r.focus;
  const total = x.drillsTotal ?? DRILLS_PER_WEEK;
  const done = Math.min(x.drillsDone ?? 0, total);
  const many = (n: number) => (n > 0 ? `${plural(n, 'position')} from your games` : 'Positions from your games');
  let hero: ReportHero;
  let title: string;
  let line: string;
  let prompt: string;
  let context: string | undefined;
  let estimate: string | undefined;
  if (f.kind === 'keepTheWin') {
    hero = heroFromConversion(r.conversion);
    title = 'Keep the win';
    line = `${many(total)} where you were winning and let it slip.`;
    prompt = KEEP_THE_WIN_PROMPT;
    context = conversionContext(r.conversion);
    const pts = r.whatIf ? round5(r.whatIf.ratingPoints) : 0;
    if (pts > 0) estimate = `About +${pts} rating points if you halve them (rough estimate)`;
  } else if (f.kind === 'clock') {
    hero = heroFromTimeLosses(r.timeLosses);
    title = 'Beat the clock';
    line = `${many(total)} where your clock was low and a move slipped.`;
    prompt = "You're low on time here. Find a good move.";
  } else {
    const leak = r.leaks.find((l) => l.key === f.key);
    hero = heroFromLeak(leak, ranked[0]?.key === f.key);
    title = leak?.label ?? 'This week';
    line = `${many(total)} where a move cost you${leak ? ` (${leak.label.toLowerCase()})` : ''}.`;
    prompt = 'Find the best move here.';
  }

  const positions: FocusPosition[] = (x.positions ?? [])
    .map((p) => ({ fen: p.fen, orientation: p.orientation, prompt: p.prompt ?? prompt }))
    .filter(isFocusPosition)
    .slice(0, MAX_FOCUS_POSITIONS);
  const focus: ReportFocus = { title, line, positions, drillsDone: Math.max(0, done), drillsTotal: total };
  if (estimate) focus.estimate = estimate;

  const view: ReportView = { kind: 'report', games: r.games, timeClass: r.timeClass, hero, leaks, focus };
  const ctx = x.context ?? context;
  if (ctx !== undefined && isText(ctx, MAX_CONTEXT_TEXT)) view.context = ctx;
  if (x.quickFixes !== undefined) {
    view.quickFixes = x.quickFixes.map(cleanQuickFix).filter(isQuickFix).slice(0, MAX_QUICK_FIXES);
  }
  if (typeof r.rangesReliable === 'boolean') view.rangesReliable = r.rangesReliable;
  if (isCta(x.cta)) view.cta = x.cta;
  return view;
}

/** Cuts text to `max` characters, ending with "…" when it had to cut. */
const fit = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * @deprecated A v3 report shown on the v4 card (until P3): the headline and subhead become the
 * hero, the focus words the lesson title, and the positions quick fixes with their answers
 * hidden. The area rows are not shown (the radar is gone).
 */
export function legacyReportToV4(v: LegacyReportView): ReportView {
  const positions = v.positions ?? [];
  const done = positions.reduce((n, p) => n + p.drillsDone, 0);
  const total = positions.reduce((n, p) => n + p.drillsTotal, 0);
  const title = fit(v.focus ? `${v.focus.charAt(0).toUpperCase()}${v.focus.slice(1)}` : 'No single focus yet', MAX_LABEL_TEXT);
  // Over-long text is cut to fit rather than refusing the whole card.
  const out: ReportView = {
    kind: 'report',
    games: v.games,
    timeClass: fit(v.timeClass, MAX_TIME_CLASS),
    hero: { headline: fit(v.headline, MAX_HERO_TEXT), sub: fit(v.subhead ?? '', MAX_HERO_TEXT) },
    leaks: [],
    focus: {
      title,
      line: positions.length > 0 ? 'Positions you keep reaching and getting wrong. Try each one before you see the answer.' : '',
      positions: [],
      drillsDone: done,
      drillsTotal: total,
    },
  };
  if (positions.length > 0) {
    out.quickFixes = positions.slice(0, MAX_QUICK_FIXES).map((p) => {
      const q = quickFixFromPosition(p, false);
      return { ...q, label: fit(q.label, MAX_LABEL_TEXT), times: fit(q.times, MAX_TIMES_TEXT) };
    });
  }
  if (v.cta !== undefined) out.cta = v.cta;
  return out;
}

/** Cuts text to MAX_STATUS_TEXT characters, ending with "…" when it had to cut. */
const fitStatus = (text: string) => (text.length <= MAX_STATUS_TEXT ? text : `${text.slice(0, MAX_STATUS_TEXT - 1)}…`);

/**
 * The waiting card: a title, one message and, for a job that can count its steps, how far it
 * has got. Like the report, it never emits what the widget would refuse: progress that doesn't
 * add up (done above total, negative, fractional, not a number) is left out, so the card shows
 * a plain waiting state, and over-long text is cut to fit.
 */
export function toStatusView(title: string, message: string, progress?: StatusProgress): CoachView {
  const view: StatusView = { kind: 'status', title: fitStatus(title), message: fitStatus(message) };
  if (progress !== undefined && isProgress(progress)) view.progress = { done: progress.done, total: progress.total };
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
/** A button label: some text, at most MAX_CTA_LENGTH characters. */
const isCta = (x: unknown): x is string => isStr(x) && x.trim().length > 0 && x.length <= MAX_CTA_LENGTH;

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

function isProgress(p: unknown): p is StatusProgress {
  return isObj(p) && isCount(p.done) && isCount(p.total) && p.done <= p.total;
}

const isStatusText = (x: unknown): x is string => isStr(x) && x.length <= MAX_STATUS_TEXT;
const isText = (x: unknown, max: number): x is string => isStr(x) && x.length <= max;
const isPct = (x: unknown): x is number => isNum(x) && x >= 0 && x <= 100;
/** Exactly these keys, no more: how the boards are kept free of answers. */
const hasOnlyKeys = (o: Obj, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

const FOCUS_KEYS = ['fen', 'orientation', 'prompt'] as const;
function isFocusPosition(p: unknown): p is FocusPosition {
  return isObj(p) && hasOnlyKeys(p, FOCUS_KEYS) && isFen(p.fen) && isColor(p.orientation) && isText(p.prompt, MAX_LABEL_TEXT * 2) && p.prompt.length > 0;
}

const QUICK_FIX_KEYS = ['fen', 'orientation', 'label', 'times', 'wrongSan', 'wrongUci', 'revealed', 'bestSan', 'bestUci'] as const;
function isQuickFix(q: unknown): q is QuickFix {
  if (!isObj(q) || !hasOnlyKeys(q, QUICK_FIX_KEYS)) return false;
  const shapeOk =
    isFen(q.fen) &&
    isColor(q.orientation) &&
    isText(q.label, MAX_LABEL_TEXT) &&
    isText(q.times, MAX_TIMES_TEXT) &&
    Array.isArray(q.wrongSan) &&
    q.wrongSan.length >= 1 &&
    q.wrongSan.length <= MAX_WRONG_MOVES &&
    q.wrongSan.every((s) => isStr(s) && SAN.test(s)) &&
    (q.wrongUci === null || (isStr(q.wrongUci) && UCI.test(q.wrongUci))) &&
    typeof q.revealed === 'boolean';
  if (!shapeOk) return false;
  // The answer is there only once revealed (and then as a real move, or not at all).
  if (!q.revealed) return q.bestSan === null && q.bestUci === null;
  return (q.bestSan === null && q.bestUci === null) || (isStr(q.bestSan) && SAN.test(q.bestSan) && isStr(q.bestUci) && UCI.test(q.bestUci));
}

function isLeak(l: unknown): l is ReportLeak {
  return (
    isObj(l) &&
    isText(l.label, MAX_LABEL_TEXT) &&
    l.label.length > 0 &&
    isPct(l.sharePct) &&
    Array.isArray(l.range) &&
    l.range.length === 2 &&
    isPct(l.range[0]) &&
    isPct(l.range[1]) &&
    l.range[0] <= l.range[1] &&
    isText(l.detail, MAX_DETAIL_TEXT)
  );
}

function isFocus(f: unknown): f is ReportFocus {
  return (
    isObj(f) &&
    isText(f.title, MAX_LABEL_TEXT) &&
    f.title.length > 0 &&
    isText(f.line, MAX_LINE_TEXT) &&
    (f.estimate === undefined || isText(f.estimate, MAX_LINE_TEXT)) &&
    Array.isArray(f.positions) &&
    f.positions.length <= MAX_FOCUS_POSITIONS &&
    f.positions.every(isFocusPosition) &&
    isCount(f.drillsDone) &&
    isCount(f.drillsTotal) &&
    f.drillsDone <= f.drillsTotal
  );
}

function isReportV4(v: Obj): boolean {
  const hero = v.hero;
  return (
    isCount(v.games) &&
    isText(v.timeClass, MAX_TIME_CLASS) &&
    isObj(hero) &&
    isText(hero.headline, MAX_HERO_TEXT) &&
    hero.headline.length > 0 &&
    isText(hero.sub, MAX_HERO_TEXT) &&
    Array.isArray(v.leaks) &&
    v.leaks.length <= MAX_REPORT_LEAKS &&
    v.leaks.every(isLeak) &&
    // Ranked: largest share first.
    v.leaks.every((l, i, all) => i === 0 || (l as ReportLeak).sharePct <= (all[i - 1] as ReportLeak).sharePct) &&
    (v.context === undefined || isText(v.context, MAX_CONTEXT_TEXT)) &&
    isFocus(v.focus) &&
    (v.quickFixes === undefined ||
      (Array.isArray(v.quickFixes) && v.quickFixes.length <= MAX_QUICK_FIXES && v.quickFixes.every(isQuickFix))) &&
    (v.rangesReliable === undefined || typeof v.rangesReliable === 'boolean') &&
    (v.cta === undefined || isCta(v.cta))
  );
}

/**
 * A checked v4 report rebuilt from its known fields only, at every level, so unknown keys never
 * reach the widget. Call only after isReportV4.
 */
function cleanReportV4(v: ReportView): ReportView {
  const f = v.focus;
  const focus: ReportFocus = {
    title: f.title,
    line: f.line,
    positions: f.positions.map((p) => ({ fen: p.fen, orientation: p.orientation, prompt: p.prompt })),
    drillsDone: f.drillsDone,
    drillsTotal: f.drillsTotal,
  };
  if (f.estimate !== undefined) focus.estimate = f.estimate;
  const out: ReportView = {
    kind: 'report',
    games: v.games,
    timeClass: v.timeClass,
    hero: { headline: v.hero.headline, sub: v.hero.sub },
    leaks: v.leaks.map((l) => ({ label: l.label, sharePct: l.sharePct, range: [l.range[0], l.range[1]], detail: l.detail })),
    focus,
  };
  if (v.context !== undefined) out.context = v.context;
  if (v.quickFixes !== undefined) out.quickFixes = v.quickFixes.map(cleanQuickFix);
  if (v.rangesReliable !== undefined) out.rangesReliable = v.rangesReliable;
  if (v.cta !== undefined) out.cta = v.cta;
  return out;
}

function isStatus(v: Obj): boolean {
  return isStatusText(v.title) && isStatusText(v.message) && (v.progress === undefined || isProgress(v.progress));
}

/** @deprecated The v3 report's shape (see LegacyReportView). */
function isLegacyReport(v: Obj): boolean {
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
    (v.cta === undefined || isCta(v.cta))
  );
}

/**
 * Checks a tool result's `structuredContent`; returns null unless it is a well-formed CoachView.
 * A report comes back as a clean copy holding only known fields (cleanReportV4); a v3 report
 * (no `hero`) that checks out comes back as its v4 card (legacyReportToV4).
 */
export function parseCoachView(x: unknown): CoachView | null {
  if (!isObj(x)) return null;
  if (x.kind === 'report' && !('hero' in x)) {
    if (!isLegacyReport(x)) return null;
    const v4 = legacyReportToV4(x as unknown as LegacyReportView);
    return isReportV4(v4 as unknown as Obj) ? cleanReportV4(v4) : null;
  }
  if (x.kind === 'report') return isReportV4(x) ? cleanReportV4(x as unknown as ReportView) : null;
  const ok =
    (x.kind === 'answer' && isAnswer(x)) ||
    (x.kind === 'question' && isQuestion(x)) ||
    (x.kind === 'status' && isStatus(x));
  return ok ? (x as unknown as CoachView) : null;
}
