/**
 * The four things the board widget can show, and pure mappers that build them from the
 * coach's data. Every tool linked to BOARD_URI returns one CoachView as `structuredContent`;
 * the widget switches on `kind`.
 *
 * The report card is v4 (spec §6c, "Where your points go"). Its lesson boards carry no answer,
 * and a quick fix carries its best move only once the player has tried that board.
 *
 * No runtime imports from node: the widget bundles this file for `parseCoachView`.
 */
import type { Color } from '../../../src/types';
import type { PositionFacts } from '../coaching/positionFacts';
import type { ExampleSource } from '../diagnosis/examples';
import type { LeakKey } from '../diagnosis/leaks';
import type { BoardView } from './boardResource';

/**
 * One position the player keeps getting wrong, deep-checked (coaching/reportPositions): their
 * usual wrong moves and the deep best move. The card shows it as a quick fix
 * (quickFixFromPosition), with the best move only once the player has tried that board.
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

/** The big plain sentence at the top of the card, and one line under it. */
export interface ReportHero {
  headline: string;
  sub: string;
  /** The coach_examples source behind the hero (the games it counts); absent when it names none. */
  source?: ExampleSource;
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
  /** The situation, as coach_examples takes it for `source`. */
  key?: LeakKey;
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
  /** The position's key (board, side to move, castling, en passant), as coach_examples takes it with source 'quickFix'. */
  key?: string;
}

/**
 * What coach_report was called with, so the widget can ask coach_examples about the same games
 * (it passes these straight on).
 */
export interface ReportQuery {
  timeClass: string;
  accounts?: { username: string; maxGames: number }[];
  usernames?: string[];
  maxGames?: number;
  asOf?: string;
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
  /** The games the card is about, for coach_examples (the drill-down). */
  query?: ReportQuery;
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

/**
 * The fields of P1's `LeakReport` that the v4 card reads, declared structurally so this file
 * (bundled by the widget) doesn't import the diagnosis code; a real LeakReport is assignable.
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
  /** What coach_report was called with (kept only if well formed). */
  query?: ReportQuery;
}

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
/** The prompt for every other lesson board: a better move, not "the" best one (right means within 5%). */
export const PLAIN_PROMPT = 'Find a better move here.';
const MAX_HERO_TEXT = 200;
const MAX_LINE_TEXT = 200;
const MAX_LABEL_TEXT = 80;
const MAX_DETAIL_TEXT = 120;
const MAX_CONTEXT_TEXT = 300;
const MAX_TIMES_TEXT = 60;
const MAX_TIME_CLASS = 40;

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

/**
 * The report card v4 (spec §6c) from a leak report: the hero sentence, the ranked bars of where
 * the points go, one context line, this week's lesson (boards with no answers, the drill count
 * and, for "Keep the win", the rough what-if), quick fixes with hidden answers, and the button.
 * See reportV4 for the rules.
 */
export function toReportView(r: LeakReportLike, extras: ReportV4Extras = {}): ReportView {
  return reportV4(r, extras);
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
 * per game" (0.75 to 1.5), and under 0.75 "About 1 costly move every N games" with
 * N = max(2, round(1 ÷ x)), so 0.74 and 0.6 both say every 2 games, 0.35 and 0.3 say every 3.
 */
export function costlyMovesText(perGame: number): string {
  if (!(perGame > 0)) return 'No costly moves here';
  if (perGame >= 1.5) return `About ${Math.round(perGame)} costly moves per game`;
  if (perGame >= 0.75) return 'About 1 costly move per game';
  return `About 1 costly move every ${Math.max(2, Math.round(1 / perGame))} games`;
}

/**
 * The hero for a single situation. A share is a leak, not a majority: "Your biggest leak: X."
 * when it is the top bar, "Your focus this week: X." when it isn't; then its share.
 */
function heroFromLeak(leak: LeakReportLike['leaks'][number] | undefined, isTop: boolean): ReportHero {
  // No games, or nothing given away yet: no situation can be named.
  if (!leak || !(leak.sharePct > 0)) return { headline: 'Not enough games yet to say where your points go.', sub: '' };
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

/** A position's key: its first four FEN fields (as diagnosis/repeated's positionKey, which this file can't import). */
const boardKey = (fen: string) => fen.split(' ', 4).join(' ');

/** A quick fix from a repeated position. The answer is kept only once revealed. */
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
    key: boardKey(p.fen),
  };
}

/** A quick fix rebuilt from an explicit list of fields, with the answer blanked unless revealed. */
function cleanQuickFix(q: QuickFix): QuickFix {
  const out: QuickFix = {
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
  if (q.key !== undefined) out.key = q.key;
  return out;
}

/** A query rebuilt from its known fields only. Call only after isQuery. */
function cleanQuery(q: ReportQuery): ReportQuery {
  const out: ReportQuery = { timeClass: q.timeClass };
  if (q.accounts !== undefined) out.accounts = q.accounts.map((a) => ({ username: a.username, maxGames: a.maxGames }));
  if (q.usernames !== undefined) out.usernames = [...q.usernames];
  if (q.maxGames !== undefined) out.maxGames = q.maxGames;
  if (q.asOf !== undefined) out.asOf = q.asOf;
  return out;
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
    const bar: ReportLeak = { label: l.label, sharePct: clamp(l.sharePct), range: [lo, hi], detail };
    if (isLeakKey(l.key)) bar.key = l.key;
    return bar;
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
    hero = { ...heroFromConversion(r.conversion), source: 'thrownWins' };
    title = 'Keep the win';
    line = `${many(total)} where you were winning and let it slip.`;
    prompt = KEEP_THE_WIN_PROMPT;
    context = conversionContext(r.conversion);
    const pts = r.whatIf ? round5(r.whatIf.ratingPoints) : 0;
    if (pts > 0) estimate = `About +${pts} rating points if you halve them (rough estimate)`;
  } else if (f.kind === 'clock') {
    hero = { ...heroFromTimeLosses(r.timeLosses), source: 'clock' };
    title = 'Beat the clock';
    line = `${many(total)} where your clock was low and a move slipped.`;
    prompt = PLAIN_PROMPT;
  } else {
    const leak = r.leaks.find((l) => l.key === f.key);
    hero = heroFromLeak(leak, ranked[0]?.key === f.key);
    if (leak && leak.sharePct > 0 && isLeakKey(f.key)) hero.source = f.key;
    title = leak?.label ?? 'This week';
    line = `${many(total)} where a move cost you${leak ? ` (${leak.label.toLowerCase()})` : ''}.`;
    prompt = PLAIN_PROMPT;
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
  if (x.query !== undefined && isQuery(x.query)) view.query = cleanQuery(x.query);
  return view;
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

/** The situations coach_examples takes as a source (diagnosis/leaks' LEAK_KEYS, which this file can't import). */
const LEAK_KEY_LIST: readonly string[] = ['clock', 'winning', 'losing', 'opening', 'endgame', 'middlegame'];
const isLeakKey = (x: unknown): x is LeakKey => isStr(x) && LEAK_KEY_LIST.includes(x);
const isExampleSource = (x: unknown): x is ExampleSource => x === 'thrownWins' || x === 'quickFix' || isLeakKey(x);
const MAX_KEY_TEXT = 100;
const MAX_ACCOUNTS = 10;
const isGameCount = (x: unknown): x is number => isCount(x) && x >= 1 && x <= 1000;
const isName = (x: unknown): x is string => isStr(x) && x.length > 0 && x.length <= 50;

function isQuery(q: unknown): q is ReportQuery {
  if (!isObj(q) || !isText(q.timeClass, MAX_TIME_CLASS) || q.timeClass.length === 0) return false;
  const accountsOk =
    q.accounts === undefined ||
    (Array.isArray(q.accounts) &&
      q.accounts.length >= 1 &&
      q.accounts.length <= MAX_ACCOUNTS &&
      q.accounts.every((a) => isObj(a) && isName(a.username) && isGameCount(a.maxGames)));
  const usernamesOk =
    q.usernames === undefined ||
    (Array.isArray(q.usernames) && q.usernames.length >= 1 && q.usernames.length <= MAX_ACCOUNTS && q.usernames.every(isName));
  return (
    accountsOk &&
    usernamesOk &&
    (q.maxGames === undefined || isGameCount(q.maxGames)) &&
    (q.asOf === undefined || (isStr(q.asOf) && /^\d{4}-\d{2}-\d{2}$/.test(q.asOf)))
  );
}

const QUICK_FIX_KEYS = ['fen', 'orientation', 'label', 'times', 'wrongSan', 'wrongUci', 'revealed', 'bestSan', 'bestUci', 'key'] as const;
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
    typeof q.revealed === 'boolean' &&
    (q.key === undefined || (isText(q.key, MAX_KEY_TEXT) && q.key.length > 0));
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
    isText(l.detail, MAX_DETAIL_TEXT) &&
    (l.key === undefined || isLeakKey(l.key))
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
    (hero.source === undefined || isExampleSource(hero.source)) &&
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
    (v.cta === undefined || isCta(v.cta)) &&
    (v.query === undefined || isQuery(v.query))
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
    leaks: v.leaks.map((l) => {
      const bar: ReportLeak = { label: l.label, sharePct: l.sharePct, range: [l.range[0], l.range[1]], detail: l.detail };
      if (l.key !== undefined) bar.key = l.key;
      return bar;
    }),
    focus,
  };
  if (v.hero.source !== undefined) out.hero.source = v.hero.source;
  if (v.context !== undefined) out.context = v.context;
  if (v.quickFixes !== undefined) out.quickFixes = v.quickFixes.map(cleanQuickFix);
  if (v.rangesReliable !== undefined) out.rangesReliable = v.rangesReliable;
  if (v.cta !== undefined) out.cta = v.cta;
  if (v.query !== undefined) out.query = cleanQuery(v.query);
  return out;
}

function isStatus(v: Obj): boolean {
  return isStatusText(v.title) && isStatusText(v.message) && (v.progress === undefined || isProgress(v.progress));
}

/**
 * Checks a tool result's `structuredContent`; returns null unless it is a well-formed CoachView.
 * A report comes back as a clean copy holding only known fields (cleanReportV4).
 */
export function parseCoachView(x: unknown): CoachView | null {
  if (!isObj(x)) return null;
  if (x.kind === 'report') return isReportV4(x) ? cleanReportV4(x as unknown as ReportView) : null;
  const ok =
    (x.kind === 'answer' && isAnswer(x)) ||
    (x.kind === 'question' && isQuestion(x)) ||
    (x.kind === 'status' && isStatus(x));
  return ok ? (x as unknown as CoachView) : null;
}
