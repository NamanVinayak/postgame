/**
 * The coach's MCP tools and the `coach_me` prompt. Every tool answers with a plain-text
 * version (for any host, and for the model) plus `structuredContent`. Tools linked to the
 * board widget (BOARD_URI) return a `CoachView` as `structuredContent`.
 *
 * The report is "Where your points go" (spec §6c), from the player's own games: the leak
 * report (diagnosis/leaks.ts) for the numbers, this week's lesson positions by its focus
 * (coaching/lessonPool.ts) and the positions the player keeps getting wrong as quick fixes.
 *
 * Every move and number shown comes from a tool: the stats, the game record, or a deep engine
 * search (DISPLAY_CFG) made just before a position is shown. Nothing model-facing carries a
 * quick-search (ENGINE_CFG) best move, and nothing carries the answer to a board the player
 * has not tried yet (try first).
 *
 * Dependencies are passed in, so tests run with fake engines and sources and never touch
 * Stockfish, the network or the real coach home.
 */
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { Chess } from 'chess.js';
import { z } from 'zod';
import { formatLineSan } from '../../../src/analysis/lines';
import type { TimeClass } from '../../../src/types';
import { readCached, type CachedGame } from '../analysis/cache';
import type { JobStatus, Query, Runner } from '../analysis/runner';
import { deepDisagrees, deepPositionFacts, repeatedRefs, type PositionFacts } from '../coaching/explain';
import {
  boardKeyFinder,
  checkMove,
  isTeachable,
  legalAttempt,
  parseRefKey,
  practiceExclusions,
  refKey,
  shownNumbers,
  triedBoard,
  type CheckResult,
  type PracticeKind,
  type Ref,
} from '../coaching/lesson';
import {
  ASK_SEARCH_BUDGET,
  MAX_DEEP_CHECKS,
  REPORT_LESSON_BOARDS,
  REPORT_SEARCH_BUDGET,
  drillsDone,
  lessonCandidates,
  lessonPrompt,
  poolPrompt,
  walkLessonPool,
  type LessonRef,
  type PoolWalk,
} from '../coaching/lessonPool';
import { buildReportPositions } from '../coaching/reportPositions';
import { searchBudget, type SearchBudget } from '../coaching/searchBudget';
import {
  addThinkingNote,
  firstTries,
  isUsername,
  lastSessionSummary,
  loadStudent,
  recordAttempt,
  saveStudent,
  setRule,
  startSession,
  type StudentFile,
} from '../coaching/student';
import { ENGINE_CFG, DISPLAY_CFG, LEAK_CFG, POSTGAME_URL, REPEAT_CFG, SOURCE_CFG } from '../config';
import { gamePlies } from '../diagnosis/areas';
import { diagnose, type Diagnosis } from '../diagnosis/diagnose';
import { EXAMPLE_SOURCES, EXAMPLES_MAX_LIMIT, examplesPage, type ExampleSource, type ExamplesPage } from '../diagnosis/examples';
import { leakReport, type LeakReport } from '../diagnosis/leaks';
import { positionKey } from '../diagnosis/repeated';
import { guardDisplayEngine, memoDisplayEngine, type DisplayEngine, type SearchMemo } from '../engine/displayEngine';
import { BOARD_URI } from './boardResource';
import { areaContext, focusLabel, hasLeakFocus, leakDiagnosisText, leakDiagnosisView } from './leakText';
import {
  DEFAULT_REPORT_CTA,
  quickFixFromPosition,
  toAnswerView,
  toQuestionView,
  toReportView,
  toStatusView,
  type QuickFix,
  type ReportQuery,
} from './views';

/** Holds the one display engine (from `createDisplayEngine`), created on first use. */
export interface DisplaySlot {
  get(): DisplayEngine;
  /**
   * Forgets (and closes) `failed` after a failure, so the next `get` builds a fresh one. Does
   * nothing if a newer engine has replaced it meanwhile.
   */
  reset(failed: DisplayEngine): void;
}

export interface EngineInfo {
  stockfishPath: string;
  binaryFound: boolean;
  analysis: { running: boolean; positionsSearched: number };
  display: { running: boolean; positionsSearched: number };
}

export interface CoachDeps {
  /** Its engine factory refuses to start Stockfish when memory is low (server.ts). */
  runner: Runner;
  display: DisplaySlot;
  engineInfo(): EngineInfo;
  /** How long coach_diagnosis waits for the game lists before answering with progress. Default 1500 ms. */
  listWaitMs?: number;
  /** How long coach_start_analysis waits for the game lists. Default 20 s. */
  startWaitMs?: number;
  /** Max time for one deep search before the display engine counts as hung. Default 30 s. */
  searchTimeoutMs?: number;
  /** The same-rating diagnosis (repeated positions and the context line; tests count calls); default `diagnose`. */
  diagnose?: typeof diagnose;
  /** Where the points go (the report and the focus; tests set the focus); default `leakReport`. */
  leakReport?: typeof leakReport;
  /** The clock for student sessions (tests move it forward); default `Date.now`. */
  now?: () => number;
  /**
   * How many searches the display engine has really run (not answered from memory or its store
   * on disk); it only grows. The per-call search budgets count with it. Default:
   * `engineInfo().display.positionsSearched`.
   */
  displaySearches?: () => number;
}

/** A student's session ends after this long without a tool writing to it. */
const SESSION_IDLE_MS = 3 * 60 * 60 * 1000;
/** What the coach asks in chat while a question board is shown (spec §6b). */
const DEFAULT_QUESTION = 'What would you play here, and what were you worried about?';
/** Analyses kept for repeat calls (one per query set and set of cached games). */
const MEMO_SIZE = 8;
/** Deep-checked positions remembered per server session (by game and ply), so a known one costs no check. */
const DEEP_FACTS_MAX = 4000;

const NO_INVENTED_FACTS =
  'Never state a move or evaluation that a tool did not return; always say how many games a finding rests on.';

// ---- input schemas ----

const TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'daily'] as const;
const usernamesSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .optional()
  .describe("The player's Chess.com usernames (one person; several accounts are pooled). Required unless accounts is given.");
const accountsSchema = z
  .array(
    z.object({
      username: z.string().trim().min(1),
      maxGames: z.number().int().min(1).max(1000).describe('How many recent rated games of this account to use'),
    }),
  )
  .min(1)
  .optional()
  .describe(
    "The same player's accounts, each with its own number of recent games. When given, it replaces usernames and maxGames.",
  );
const timeClassSchema = z.enum(TIME_CLASSES).default('blitz').describe('Time class of the games to use');
const maxGamesSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(SOURCE_CFG.defaultMaxGames)
  .describe('How many recent rated games to use');

/** True for a real calendar date written YYYY-MM-DD (so 2026-02-30 is not one). */
export function isRealDate(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const asOfSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-01')
  .refine(isRealDate, 'not a real date')
  .optional()
  .describe('Only use games that ended before this date (YYYY-MM-DD, UTC). Leave out for the latest games.');

interface QueryArgs {
  usernames?: string[];
  accounts?: { username: string; maxGames: number }[];
  timeClass: TimeClass;
  maxGames: number;
  asOf?: string;
}

/**
 * One runner query per account when `accounts` is given (each with its own game limit; the
 * results are concatenated), else one pooled query for `usernames`. A string is a refusal.
 */
function toQueries(a: QueryArgs): Query[] | string {
  const before = a.asOf ? Math.floor(Date.parse(`${a.asOf}T00:00:00Z`) / 1000) : undefined;
  const query = (usernames: string[], maxGames: number): Query =>
    before === undefined ? { usernames, timeClass: a.timeClass, maxGames } : { usernames, timeClass: a.timeClass, maxGames, before };
  if (a.accounts && a.accounts.length > 0) {
    const seen = new Set<string>();
    const out: Query[] = [];
    for (const acc of a.accounts) {
      const k = acc.username.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(query([acc.username], acc.maxGames));
    }
    return out;
  }
  if (a.usernames && a.usernames.length > 0) return [query(a.usernames, a.maxGames)];
  return "Give the player's Chess.com usernames (or accounts).";
}

/**
 * What a report was asked about, for its drill-down (coach_examples takes the same fields):
 * the time class, the accounts or usernames as given, the game count for usernames, and asOf.
 */
function echoQuery(a: QueryArgs): ReportQuery {
  const q: ReportQuery = { timeClass: a.timeClass };
  if (a.accounts && a.accounts.length > 0) q.accounts = a.accounts.map((x) => ({ username: x.username, maxGames: x.maxGames }));
  if (a.usernames && a.usernames.length > 0) q.usernames = [...a.usernames];
  if (!q.accounts) q.maxGames = a.maxGames;
  if (a.asOf) q.asOf = a.asOf;
  return q;
}

// ---- small helpers ----

type Started = { jobId: string; total: number; cached: number };
type Result = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function reply(text: string, structuredContent?: Record<string, unknown>): Result {
  return structuredContent ? { content: [{ type: 'text', text }], structuredContent } : { content: [{ type: 'text', text }] };
}

function failure(text: string): Result {
  return { content: [{ type: 'text', text }], isError: true };
}

/** The promise's value, or null if it takes longer than `ms`. Rejections pass through. */
async function within<T>(p: Promise<T>, ms: number): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const moveLabel = (moveNumber: number, mover: 'white' | 'black', san: string) =>
  `${moveNumber}${mover === 'white' ? '.' : '...'} ${san}`;

function progressText(done: number, total: number, skipped: number): string {
  const skip = skipped ? ` ${plural(skipped, 'game')} could not be read and will be left out.` : '';
  return (
    `Still working: analysed ${done} of ${plural(total, 'game')} so far.${skip} ` +
    'The diagnosis needs every game, so ask again in a minute or two.'
  );
}

/** The deep facts as text, for the model and for hosts without the board. */
export function explainText(f: PositionFacts, disagrees: boolean): string {
  const side = capitalize(f.mover);
  const moveNumber = Math.floor(f.ply / 2) + 1;
  const after = new Chess(f.fenAfter);
  const mated = after.isCheckmate();
  const stalemate = after.isStalemate();
  const lines = [
    `Game ${f.gameUrl}, move ${moveLabel(moveNumber, f.mover, f.playedSan)} (ply ${f.ply}, ${side} to move).`,
    `Position before the move (FEN): ${f.fenBefore}`,
    `${side} played ${f.playedSan} (${f.playedUci}).`,
  ];
  if (mated) {
    lines.push(`${f.playedSan} is checkmate, so it is the best move: the game ended here and nothing needed searching.`);
  } else {
    lines.push(f.bestSan ? `Stockfish's best move: ${f.bestSan} (${f.bestUci}).` : `${f.playedSan} was Stockfish's first choice.`);
    if (f.bestLineSan?.length) lines.push(`Best line: ${formatLineSan(f.bestLineSan, f.ply)}.`);
  }
  lines.push(`${side}'s win chance: ${Math.round(f.winBefore)}% before the move, ${Math.round(f.winAfter)}% after.`);
  if (f.refutationSan?.length) lines.push(`The opponent's strongest reply after ${f.playedSan}: ${formatLineSan(f.refutationSan, f.ply + 1)}.`);
  if (f.reason) lines.push(`Why: ${f.reason}`);
  if (disagrees) lines.push("On a deeper check this move holds up, so it isn't a real mistake.");
  if (mated) {
    lines.push('Decided by the rules (checkmate); these are the only moves and numbers to quote for this position.');
  } else if (stalemate) {
    lines.push(
      'The position before the move was checked with a deeper search just now; stalemate after it is a draw by the rules. ' +
        'These are the only moves and numbers to quote for this position.',
    );
  } else {
    lines.push('Checked with a deeper search just now; these are the only moves and numbers to quote for this position.');
  }
  return lines.join('\n');
}

// ---- the coaching session ----

/**
 * A question position as text: where it is and the position, never the game move, the best
 * move, a win % or how the move was graded (try-first). The board shows `prompt` above the
 * position; the coach asks DEFAULT_QUESTION in chat.
 */
export function questionText(f: PositionFacts, prompt: string): string {
  const side = capitalize(f.mover);
  return [
    `Question position: gameId ${f.gameId}, ply ${f.ply} (move ${Math.floor(f.ply / 2) + 1}, ${side} to move; the player was ${side}).`,
    `Position (FEN): ${f.fenBefore}`,
    `The board shows the position only, with no hint, under the line "${prompt}". Ask: "${DEFAULT_QUESTION}" ` +
      "Then wait for the player's move and reason, without naming or hinting at any move or evaluation. Then call " +
      'coach_check_move with this gameId and ply and their move.',
  ].join('\n');
}

/**
 * A scored attempt as text: the verdict, both win chances, the lines, and the game move's numbers
 * labelled as such. The numbers are `shownNumbers`: near the 5-point line a wrong verdict shows
 * them to one decimal, rounded so it never reads as within the line.
 */
export function checkText(r: Extract<CheckResult, { legal: true }>, tally: string | null): string {
  const f = r.facts;
  const side = capitalize(f.mover);
  const tried = r.attempt.moveSan;
  const n = shownNumbers(r);
  const num = (x: number) => (n.decimals ? x.toFixed(1) : String(Math.round(x)));
  const bestSan = f.bestSan ?? f.playedSan;
  const bestUci = f.bestUci ?? f.playedUci;
  const lines = [
    `Position: gameId ${f.gameId}, ply ${f.ply} (move ${Math.floor(f.ply / 2) + 1}, ${side} to move).`,
    `The player tried ${tried} (${r.attempt.moveUci}).`,
    r.isBest
      ? "Right: that is Stockfish's best move."
      : r.correct
        ? `Right: it is within ${REPEAT_CFG.wrongLossPts}% of the best move (it loses about ${num(n.lossPts)}%).`
        : `Not right: it loses about ${num(n.lossPts)}% win chance against the best move.`,
    `Your move keeps about ${num(n.attemptWin)}% win chance; the best move keeps ${num(n.bestWin)}%.`,
  ];
  if (!r.isBest) lines.push(`Stockfish's best move: ${bestSan} (${bestUci}).`);
  if (f.bestLineSan?.length) lines.push(`Best line: ${formatLineSan(f.bestLineSan, f.ply)}.`);
  if (!r.isBest && r.attemptRefutationSan?.length) {
    lines.push(`The opponent's strongest reply to ${tried}: ${formatLineSan(r.attemptRefutationSan, f.ply + 1)}.`);
  }
  if (r.isGameMove) {
    lines.push(`${tried} is also the move played in the game.`);
    if (!r.isBest && f.reason) lines.push(`Why: ${f.reason}`);
  } else {
    lines.push(
      `In the game the player chose ${f.playedSan}: ${side}'s win chance went from ${Math.round(f.winBefore)}% to ` +
        `${Math.round(f.winAfter)}%${f.bestUci === null ? ' (that was the best move)' : ''}.`,
    );
    if (f.bestUci !== null && f.refutationSan?.length) {
      lines.push(`The opponent's strongest reply to ${f.playedSan} (the game move): ${formatLineSan(f.refutationSan, f.ply + 1)}.`);
    }
    if (f.bestUci !== null && f.reason) lines.push(`About the game move: ${f.reason}`);
  }
  if (tally) lines.push(tally);
  lines.push(
    'Checked with a deeper search just now; these are the only moves and numbers to quote for this position. ' +
      "Next: name the thinking error behind the player's reason (save it with coach_note_thinking), then show the refutation.",
  );
  return lines.join('\n');
}

/**
 * A page of examples as text for the model: one line per game ("Move 23 (Qxb7): 82% → 30% (quick
 * check)") with its date, the opponent's rating and the result, and its gameId and ply to ask it.
 * No best move: the numbers are the quick check's.
 */
export function examplesText(p: ExamplesPage): string {
  const n = p.examples.length;
  const lines = [
    `${p.title}: ${plural(p.total, 'game')}` +
      (n > 0 ? `, showing ${p.offset + 1}–${p.offset + n}, newest first` : p.total > 0 ? `; none from ${p.offset + 1} on` : '') +
      ' (win chances from the quick check, approximate).',
  ];
  p.examples.forEach((e, i) => {
    const result = e.result === 'win' ? 'won' : e.result === 'loss' ? 'lost' : 'drawn';
    lines.push(
      `${p.offset + i + 1}. ${e.date}, vs ${e.opponentRating ?? 'unrated'}, ${result}, you were ${capitalize(e.myColor)}: ` +
        `Move ${e.slipMoveNo} (${e.playedSan}): ${Math.round(e.quickWinBefore)}% → ${Math.round(e.quickWinAfter)}% (quick check). ` +
        `gameId ${e.gameId}, ply ${e.slipPly}.`,
    );
  });
  if (p.offset + n < p.total) lines.push(`More: call coach_examples again with offset ${p.offset + n}.`);
  if (n > 0) {
    lines.push(
      'No best moves here: to practise one, call coach_ask_position with its gameId and ply (it is checked with a deeper ' +
        'search first). Never name a better move for any of them before the player has tried.',
    );
  }
  return lines.join('\n');
}

/** The habit "Keep the win" trains, in the words the coach says it. */
export const BLUNDER_CHECK = "before every move when you're winning, check their checks, captures and threats";

/**
 * The coach's script for one session (spec §6b, steps 1–8, with the §6c lesson content), plus
 * the rules. Only names tools that exist.
 */
export function coachMeText(username: string): string {
  const u = username;
  return [
    `Coach me on my Chess.com games. My username is ${u}.`,
    '',
    'You are my chess coach for one session of about 15 minutes. The report only starts the lesson; ' +
      'the teaching is what matters. Follow this script, one step at a time, and wait for me where it says so.',
    '',
    'Before you start:',
    `- Ask me once whether to include other Chess.com accounts of mine, and how many recent games of each. ` +
      `If I don't say, use just ${u} and the last ${SOURCE_CFG.defaultMaxGames} blitz games.`,
    `- One account: pass usernames ["${u}"] to the tools. Several: pass accounts [{ username, maxGames }, ...] instead, ` +
      `with ${u} first (the first account names my student file). Use the same accounts for every tool all session.`,
    '- If I am playing a game right now, stop and offer to look at it after the game.',
    '',
    'The session:',
    '1. Report card. Call coach_start_analysis, then coach_diagnosis until it is done (while games are still being ' +
      'analysed, tell me how far it got and check again shortly). Then call coach_report; the board shows the report card: ' +
      "where my points go, this week's focus with its lesson boards, and quick fixes. Add a one- or two-sentence headline of " +
      "your own, nothing more; give the card in text only if the board didn't show. The card's boards are practice " +
      "positions: don't name their moves.",
    '2. Warm-up. Call coach_student. If I had an earlier session, first ask its warm-up position again with ' +
      'coach_ask_position (that gameId and ply), the same way as step 4. Only after my try, tell me the line from last time ' +
      '("Last time: …, 4 of 7 right") and the thinking errors noted then. If this is my first session, skip this step.',
    "3. Today's theme: the one focus from the report, with my own numbers (for example how many of the games I was " +
      'clearly winning I lost, or the share of what I give away) and the number of games they rest on.',
    '4. A guided position, where I try first:',
    "   - Call coach_ask_position without a gameId. It picks a position from my games for this week's focus, checks it " +
      'with a deeper search, and shows it as a question: no arrows, no hint.',
    '   - Ask: "What would you play here, and what were you worried about?" Then wait. I either move on the board ' +
      '(it puts "I played … here, because" in the chat for me to finish) or type my move and my reason.',
    '   - Once you have my move and my reason, call coach_check_move with that gameId and ply and my move. ' +
      'The board then shows my move against the best move.',
    '   - Say in one line whether I was right, using the win chances the tool gives. Then name the thinking error behind ' +
      'my reason, not just the move (for example "you didn\'t ask what their last move threatened"), and save it with ' +
      "coach_note_thinking. Then show the refutation, from the tool's lines.",
    `   - When the focus is "Keep the win", these are positions where I was winning and let it slip; the board says ` +
      `"You're winning here. Find the move that keeps it." After my try, coach the blunder check: ${BLUNDER_CHECK}.`,
    '5. Practice: three to five more positions of the same pattern, each with coach_ask_position (no gameId) and the same ' +
      'try-first loop. After a few, point out what the positions have in common. If coach_ask_position says no position is ' +
      'ready, that there are no more, or that it is enough for today, stop there and tell me honestly how many we did; a ' +
      "short session is fine. Don't make positions up.",
    '6. One rule of thumb for my live games, in one sentence, drawn from the thinking errors you saw. Save it with ' +
      `coach_note_thinking (rule). For "Keep the win" it is the blunder check: "${BLUNDER_CHECK}".`,
    `7. Homework: about 30 more games in the same time class before the next session, and practice of this focus on my ` +
      `phone in Postgame (${POSTGAME_URL}). The weekly target is ${LEAK_CFG.drillsPerWeek} positions for the focus (the ` +
      "card counts them). If you have a tool that sends drills to Postgame, use it; otherwise don't promise drills.",
    '8. Close by saying what the next session does: it starts from my student file ("last time: …, 4 of 7 right"), ' +
      'and once I have played about 30 new games, it re-checks this focus on them with a fresh coach_diagnosis.',
    '',
    'If I ask which games a finding comes from, call coach_examples with the same accounts (the board lists them, ' +
      'newest first, with no answers). If I write "Coach me on this position: game <gameId>, ply <ply>", call ' +
      'coach_ask_position with that gameId and ply and run the same try-first loop as step 4.',
    '',
    'Rules:',
    '- Never reveal the answer before I try: no best move, no evaluation and no hint that points at a move until ' +
      'coach_check_move has scored my try. If I ask for a hint, ask a thinking question instead ("what changed after their last move?").',
    "- Never open a practice position with coach_explain_position before I've tried it.",
    '- After the answer, name the thinking error first, then show the refutation.',
    '- Three to five positions of the same pattern.',
    '- One rule of thumb per session.',
    '- Never state a move or evaluation that a tool did not return.',
    '- Always say how many games a finding rests on.',
    "- Say 'not enough data' plainly when a tool says so; never guess past it.",
    '- One focus at a time.',
    '- No help during a live game: if I am playing right now, stop and offer to look after the game.',
    '- Plain English and short turns: one position at a time.',
  ].join('\n');
}

/** Unique by game id (first wins): two of the player's accounts may have played each other. */
function uniqueGames(lists: CachedGame[][]): CachedGame[] {
  const seen = new Set<string>();
  const out: CachedGame[] = [];
  for (const c of lists.flat()) {
    if (seen.has(c.game.id)) continue;
    seen.add(c.game.id);
    out.push(c);
  }
  return out;
}

// ---- registration ----

/** One query set's analysed games and everything worked out from them, kept for repeat calls. */
interface Analysed {
  games: CachedGame[];
  usernames: string[];
  /** The same-rating diagnosis: the repeated positions and the one context line. */
  d: Diagnosis;
  /** Where the points go: the report, the focus and the what-if. */
  leak: LeakReport;
  /** d.repeated with the sighting to ask, in the same order. */
  repeated: { key: string; ref: Ref | null }[];
  /** Games per account (only when several accounts are pooled). */
  byAccount: { username: string; games: number }[];
  /** This week's lesson candidates for leak.focus, worked out on first use. */
  pool?: LessonRef[];
}

/** What the server remembers about one player's lesson. */
interface Lesson {
  /** Lowercased primary username: names the student file. */
  player: string;
  /** Every account of this player, lowercased (the primary one too). */
  accounts: Set<string>;
  a: Analysed;
  /** The focus in plain words, as the student file stores it. */
  focus: string | null;
  /** The student session (`OpenSession.tag`) that `asked` and `picked` belong to. */
  askedTag: number;
  /** Positions asked in this student session, as refKeys. Starts empty in each new session. */
  asked: Set<string>;
  /** Practice positions picked in this student session (the guided one and the practice ones). */
  picked: number;
}

/** A student session as this server sees it; `index` is its place in the student file once something is written. */
interface OpenSession {
  tag: number;
  index: number | null;
  lastAt: number;
}

type DiagnosisOutcome =
  | { ready: false; waiting: false; result: Result }
  | { ready: false; waiting: true; result: Result; done: number; total: number }
  | { ready: true; a: Analysed; qs: Query[]; skipped: number; player: string };

const optionalUsername = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("The player's primary Chess.com username (names the student file). Leave out to use this session's player.");

/** Positions picked per session without a gameId: about one guided position and five practice ones. */
const SESSION_POSITIONS = 6;

export function registerCoachTools(server: McpServer, deps: CoachDeps): void {
  const listWaitMs = deps.listWaitMs ?? 1500;
  const startWaitMs = deps.startWaitMs ?? 20_000;
  const searchTimeoutMs = deps.searchTimeoutMs ?? 30_000;
  const diagnoseFn = deps.diagnose ?? diagnose;
  const leakReportFn = deps.leakReport ?? leakReport;
  const now = deps.now ?? Date.now;
  const displaySearches = deps.displaySearches ?? (() => deps.engineInfo().display.positionsSearched);
  const memo = new Map<string, Analysed>();
  /** Every deep search of this session, so a position always gets the same answer. */
  const searches: SearchMemo = new Map();
  /** Every deep-checked position of this session, by refKey: a known one costs no check. */
  const deepFacts = new Map<string, PositionFacts>();
  const lessons = new Map<string, Lesson>();
  /** The player of the last diagnosis or report (or the last name given): the default for the coaching tools. */
  let currentPlayer: string | null = null;
  /** The student session each player is in, as this server sees it. */
  const sessions = new Map<string, OpenSession>();
  let nextTag = 1;

  /** The display engine with a time limit per search and this session's search memo. */
  function deepEngine(): DisplayEngine {
    const engine = deps.display.get();
    return memoDisplayEngine(
      guardDisplayEngine(engine, searchTimeoutMs, () => deps.display.reset(engine)),
      searches,
    );
  }

  /** A position's deep facts (DISPLAY_CFG), remembered for this session by game and ply. */
  async function deepCheck(c: CachedGame, ply: number, engine: DisplayEngine): Promise<PositionFacts> {
    const k = refKey(c.game.id, ply);
    const known = deepFacts.get(k);
    if (known) return known;
    const facts = await deepPositionFacts(c, ply, engine);
    deepFacts.set(k, facts);
    while (deepFacts.size > DEEP_FACTS_MAX) deepFacts.delete(deepFacts.keys().next().value as string);
    return facts;
  }
  const knownFacts = (r: Ref) => deepFacts.get(refKey(r.gameId, r.ply));

  /** Starts by query, from this server session: the diagnosis reuses them instead of re-walking the archives. */
  interface Tracked {
    q: Query;
    started: Promise<Started>;
    result?: Started;
    error?: string;
  }
  const tracked = new Map<string, Tracked>();
  const keyOf = (q: Query) => JSON.stringify([[...q.usernames].sort(), q.timeClass, q.maxGames, q.before ?? null]);

  /** One start at a time, so game lists are fetched from Chess.com one request after another. */
  let startChain: Promise<unknown> = Promise.resolve();
  function startInTurn(q: Query): Promise<Started> {
    const p = startChain.then(() => deps.runner.start(q));
    startChain = p.catch(() => undefined);
    return p;
  }

  /** The tracked start for a query; a new one when none exists or `fresh` is set. */
  function track(q: Query, fresh: boolean): Tracked {
    const key = keyOf(q);
    const existing = tracked.get(key);
    if (existing && !fresh) return existing;
    const t: Tracked = { q, started: startInTurn(q) };
    t.started.then(
      (r) => (t.result = r),
      (e) => (t.error = msg(e)),
    );
    tracked.set(key, t);
    return t;
  }

  function forget(ts: Tracked[]): void {
    for (const t of ts) if (tracked.get(keyOf(t.q)) === t) tracked.delete(keyOf(t.q));
  }

  /**
   * The analysis for a set of queries, shared by coach_diagnosis and coach_report: progress
   * while games are fetched or analysed, a plain failure, or the analysed games with the leak
   * report and the same-rating diagnosis (which also become the player's lesson for the
   * coaching tools).
   */
  async function diagnosisFor(args: QueryArgs): Promise<DiagnosisOutcome> {
    const qs = toQueries(args);
    if (typeof qs === 'string') return { ready: false, waiting: false, result: failure(qs) };
    const ts = qs.map((q) => track(q, false));
    const broken = ts.find((t) => t.error !== undefined);
    if (broken) {
      forget(ts);
      return { ready: false, waiting: false, result: failure(`Could not get the game list from Chess.com: ${broken.error}. Call again to retry.`) };
    }
    let r: { value: Started[] } | null;
    try {
      r = await within(Promise.all(ts.map((t) => t.started)), listWaitMs);
    } catch (e) {
      forget(ts);
      return { ready: false, waiting: false, result: failure(`Could not get the game list from Chess.com: ${msg(e)}. Call again to retry.`) };
    }
    if (!r) {
      return {
        ready: false,
        waiting: true,
        done: 0,
        total: 0,
        result: reply('Getting the game lists from Chess.com. Ask again in a moment.', { state: 'fetching' }),
      };
    }

    const jobIds = r.value.map((st) => st.jobId);
    const statuses: JobStatus[] = jobIds.map((id) => deps.runner.status(id));
    const failed = statuses.find((st) => st.state === 'error');
    if (failed) {
      forget(ts);
      return { ready: false, waiting: false, result: failure(`The analysis stopped: ${failed.error}. Call coach_start_analysis to try again.`) };
    }
    const sum = (f: (st: JobStatus) => number) => statuses.reduce((n, st) => n + f(st), 0);
    const skipped = sum((st) => st.skipped ?? 0);
    if (statuses.some((st) => st.state === 'running')) {
      const done = sum((st) => st.done);
      const total = sum((st) => st.total);
      return {
        ready: false,
        waiting: true,
        done,
        total,
        result: reply(progressText(done, total, skipped), { state: 'running', jobIds, done, total, skipped }),
      };
    }

    // Reading the cache is fast; the analysis itself is not (about 3 s for 900 games), so it is
    // kept per query set and exact set of cached games, and redone when either changes. The kept
    // game objects are reused, so each game is replayed once.
    const loaded = uniqueGames(await Promise.all(qs.map((q) => deps.runner.load(q))));
    const memoKey = createHash('sha256')
      .update(JSON.stringify([qs.map(keyOf), loaded.map((c) => c.game.id).sort()]))
      .digest('hex');
    let a = memo.get(memoKey);
    if (!a) {
      const usernames = qs.flatMap((q) => q.usernames);
      const d = diagnoseFn(loaded, usernames);
      const refs = repeatedRefs(d, loaded);
      const byAccount =
        qs.length > 1
          ? qs.map((q) => {
              const names = new Set(q.usernames.map((u) => u.toLowerCase()));
              const n = loaded.filter((c) => names.has(c.game.username.toLowerCase()) && gamePlies(c) !== null).length;
              return { username: q.usernames.join(', '), games: n };
            })
          : [];
      a = {
        games: loaded,
        usernames,
        d,
        leak: leakReportFn(loaded, usernames),
        repeated: d.repeated.map((p, i) => ({ key: p.key, ref: refs[i] ?? null })),
        byAccount,
      };
      memo.set(memoKey, a);
      if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value as string);
    }

    const player = qs[0].usernames[0].toLowerCase();
    const prev = lessons.get(player);
    lessons.set(player, {
      player,
      accounts: new Set(qs.flatMap((q) => q.usernames.map((u) => u.toLowerCase()))),
      a,
      focus: focusLabel(a.leak),
      askedTag: prev?.askedTag ?? 0,
      asked: prev?.asked ?? new Set(),
      picked: prev?.picked ?? 0,
    });
    currentPlayer = player;
    return { ready: true, a, qs, skipped, player };
  }

  /** This week's lesson candidates for an analysis's focus (worked out once per analysis). */
  function poolOf(a: Analysed): LessonRef[] {
    a.pool ??= lessonCandidates(a.leak.focus, a.games, a.usernames, a.repeated);
    return a.pool;
  }

  /**
   * What practice passes over: what was tried in the running student session and boards learned
   * (practiceExclusions), plus, with `asked`, what was asked in this session; with their boards.
   */
  function exclusions(lesson: Lesson, student: StudentFile | undefined, asked: boolean): { refs: Set<string>; boards: Set<string> } {
    const byId = new Map(lesson.a.games.map((c) => [c.game.id, c]));
    const refs = new Set<string>(asked ? lesson.asked : []);
    if (student) for (const k of practiceExclusions(student, openIndex(lesson.player, student), byId)) refs.add(k);
    const boardOf = boardKeyFinder(byId);
    const boards = new Set<string>();
    for (const k of refs) {
      const r = parseRefKey(k);
      const b = r ? boardOf(r.gameId, r.ply) : null;
      if (b) boards.add(b);
    }
    return { refs, boards };
  }

  /** Walks the lesson's pool with this session's deep checks, within `budget` (searches that really run). */
  function walkPool(
    lesson: Lesson,
    want: number,
    exclude: { refs: Set<string>; boards: Set<string> },
    budget: SearchBudget,
  ): Promise<PoolWalk> {
    const byId = new Map(lesson.a.games.map((c) => [c.game.id, c]));
    let engine: DisplayEngine | null = null;
    return walkLessonPool(poolOf(lesson.a), {
      want,
      budget,
      load: (id) => byId.get(id) ?? readCached(id),
      known: knownFacts,
      deep: (c, ply) => deepCheck(c, ply, (engine ??= deepEngine())),
      exclude,
    });
  }

  /** The primary account for a name: one of a lesson's other accounts maps to that lesson's player. */
  function primaryOf(name: string): string {
    const n = name.toLowerCase();
    for (const l of lessons.values()) if (l.accounts.has(n)) return l.player;
    return n;
  }

  /**
   * The player a coaching tool is about, as the primary account's lowercased name (it names the
   * student file). A name given is checked first (a bad one throws) and becomes this session's
   * player, mapped to its primary account; else this session's player; else the game's account,
   * mapped the same way.
   */
  function playerFor(username: string | undefined, c?: CachedGame): string | null {
    if (username !== undefined) {
      if (!isUsername(username)) throw new Error(`"${username}" is not a Chess.com username`);
      return (currentPlayer = primaryOf(username));
    }
    return currentPlayer ?? (c ? primaryOf(c.game.username) : null);
  }

  /**
   * The player's student session, kept alive by this call. A new one starts when there is none
   * in this server yet, or after SESSION_IDLE_MS without any coaching tool for this player.
   */
  function touchSession(player: string): OpenSession {
    const t = now();
    let cur = sessions.get(player);
    if (!cur || t - cur.lastAt > SESSION_IDLE_MS) {
      cur = { tag: nextTag++, index: null, lastAt: t };
      sessions.set(player, cur);
    }
    cur.lastAt = t;
    return cur;
  }

  /** The running session's index in the student file, or null when nothing is written in it yet (or it has ended). */
  function openIndex(player: string, s: StudentFile): number | null {
    const cur = sessions.get(player);
    if (!cur || now() - cur.lastAt > SESSION_IDLE_MS || cur.index === null || cur.index !== s.sessions.length - 1) return null;
    return cur.index;
  }

  /** The lesson's session state, emptied when the student session has rolled over. */
  function lessonSession(lesson: Lesson): void {
    const cur = touchSession(lesson.player);
    if (lesson.askedTag !== cur.tag) {
      lesson.askedTag = cur.tag;
      lesson.asked = new Set();
      lesson.picked = 0;
    }
  }

  /**
   * Loads, edits and saves the player's student file. The first write of a student session
   * opens a new session in the file, with the lesson's focus.
   */
  function editStudent(player: string, edit: (s: StudentFile) => StudentFile): StudentFile {
    const cur = touchSession(player);
    let s = loadStudent(player);
    if (cur.index === null || cur.index !== s.sessions.length - 1) s = startSession(s, lessons.get(player)?.focus ?? null, now());
    s = edit(s);
    saveStudent(s);
    cur.index = s.sessions.length - 1;
    return s;
  }

  function studentOrNothing(player: string): StudentFile | undefined {
    try {
      return loadStudent(player);
    } catch {
      return undefined;
    }
  }

  /** A cached game and one of the player's own plies in it, or the reason it can't be used. */
  function ownPosition(gameId: string, ply: number): { c: CachedGame } | { error: Result } {
    const c = readCached(gameId);
    if (!c) {
      return {
        error: failure(
          `Game ${gameId} is not among the analysed games, so there is nothing to show. Use a gameId a tool gave ` +
            '(the Chess.com game URL), after coach_diagnosis has finished.',
        ),
      };
    }
    const plies = c.analysis.plies;
    const p = plies[ply];
    if (!p) return { error: failure(`Game ${gameId} has plies 0 to ${plies.length - 1}; ply ${ply} is not one of them.`) };
    if (p.color !== c.game.myColor) {
      const own = [ply - 1, ply + 1].filter((x) => x >= 0 && x < plies.length);
      return {
        error: failure(
          `Ply ${ply} (${moveLabel(Math.floor(ply / 2) + 1, p.color, p.moveSan)}) is your opponent's move, not yours. ` +
            `The board shows your own moves only (you were ${capitalize(c.game.myColor)} in this game)` +
            `${own.length ? `: try ply ${own.join(' or ')}` : ''}.`,
        ),
      };
    }
    return { c };
  }

  registerAppTool(
    server,
    'coach_explain_position',
    {
      title: 'Show a position on the board',
      description:
        "Shows one of the player's own moves from an analysed game on a chess board: the move played (red arrow), " +
        "Stockfish's best move (green arrow) and best line, the opponent's strongest reply, and the win chance before " +
        'and after. Stockfish first re-checks the position with a deeper search, so this takes a few seconds. ' +
        'Use it for a position the player has already tried (coach_check_move), or one that is not a practice position. ' +
        'Never for a practice position the player has not tried yet: it shows the answer. ' +
        NO_INVENTED_FACTS,
      inputSchema: {
        gameId: z.string().min(1).describe('Game id of an analysed game (the Chess.com game URL), as a tool gave it'),
        ply: z.number().int().min(0).describe("0-based ply (0 is White's first move); must be the player's own move"),
      },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ gameId, ply }) => {
      const own = ownPosition(gameId, ply);
      if ('error' in own) return own.error;
      let facts: PositionFacts;
      try {
        facts = await deepPositionFacts(own.c, ply, deepEngine());
      } catch (e) {
        return failure(`Could not check this position: ${msg(e)}`);
      }
      const disagrees = deepDisagrees(own.c.analysis.plies[ply].classification, facts.classification);
      return reply(explainText(facts, disagrees), { ...toAnswerView(facts), deepDisagrees: disagrees });
    },
  );

  server.registerTool(
    'coach_start_analysis',
    {
      title: 'Start analysing games',
      description:
        "Fetches the player's recent rated Chess.com games and starts analysing the ones not analysed yet, in the background " +
        `(Stockfish, ${ENGINE_CFG.movetimeMs} ms per position). Returns at once with how many games there are. ` +
        'Also refreshes the game lists. Then call coach_diagnosis with the same arguments.',
      inputSchema: { usernames: usernamesSchema, accounts: accountsSchema, timeClass: timeClassSchema, maxGames: maxGamesSchema },
    },
    async (args) => {
      const qs = toQueries(args);
      if (typeof qs === 'string') return failure(qs);
      const ts = qs.map((q) => track(q, true));
      let r: { value: Started[] } | null;
      try {
        r = await within(Promise.all(ts.map((t) => t.started)), startWaitMs);
      } catch (e) {
        forget(ts);
        return failure(`Could not get the game list from Chess.com: ${msg(e)}`);
      }
      if (!r) {
        return reply(
          'Still getting the game lists from Chess.com; any games not analysed yet will be analysed after that. Call coach_diagnosis in a minute.',
          { state: 'fetching' },
        );
      }
      const accounts = r.value.map((st, i) => ({ usernames: qs[i].usernames, jobId: st.jobId, total: st.total, cached: st.cached }));
      const statuses = accounts.map((a) => deps.runner.status(a.jobId));
      const total = accounts.reduce((n, a) => n + a.total, 0);
      const cached = accounts.reduce((n, a) => n + a.cached, 0);
      const done = statuses.reduce((n, st) => n + st.done, 0);
      const state = statuses.some((st) => st.state === 'error') ? 'error' : statuses.some((st) => st.state === 'running') ? 'running' : 'done';
      const tc = qs[0].timeClass;
      const names = accounts.map((a) => a.usernames.join(', ')).join(', ');
      let text: string;
      if (total === 0) {
        text = `No rated ${tc} games found for ${names}.`;
      } else {
        text =
          accounts.length === 1
            ? `Found ${plural(total, `${tc} game`)} for ${names}: ${cached} analysed already.`
            : `Found ${plural(total, `${tc} game`)} in all: ` +
              `${accounts.map((a) => `${a.usernames.join(', ')} ${a.total} (${a.cached} analysed already)`).join('; ')}.`;
        text +=
          cached === total
            ? ' All are analysed. Call coach_diagnosis.'
            : ` Analysing the other ${total - cached} in the background. Call coach_diagnosis to see progress or the result.`;
      }
      return reply(text, { jobIds: accounts.map((a) => a.jobId), total, cached, done, state, accounts });
    },
  );

  server.registerTool(
    'coach_diagnosis',
    {
      title: 'Where your points go',
      description:
        "Where the player's points go, from their own analysed games: the six situations (low on the clock, already " +
        'winning, already losing, the first 10 moves, endgames, balanced middlegames) ranked by the share of winning ' +
        'chances given away, how often clearly winning games were kept, losses on time, one rough what-if and this ' +
        "week's focus, plus one line comparing them with players at their rating. While games are still being fetched or " +
        'analysed it answers within 2 seconds with how far it got; call it again later. Say plainly when it says there is ' +
        'not enough data. It names no moves: the positions behind it are practice positions, asked one at a time with ' +
        'coach_ask_position. ' +
        NO_INVENTED_FACTS,
      inputSchema: {
        usernames: usernamesSchema,
        accounts: accountsSchema,
        timeClass: timeClassSchema,
        maxGames: maxGamesSchema,
        asOf: asOfSchema,
      },
    },
    async (args) => {
      const o = await diagnosisFor(args);
      if (!o.ready) return o.result;
      const a = o.a;
      const context = areaContext(a.d);
      let text = leakDiagnosisText(a.leak, { context, gamesByAccount: a.byAccount, repeated: a.d.repeated.length });
      if (o.skipped) text += `\n\n${plural(o.skipped, 'game')} could not be read and ${o.skipped === 1 ? 'was' : 'were'} left out.`;
      return reply(text, { ...leakDiagnosisView(a.leak, { context, gamesByAccount: a.byAccount, repeated: a.d.repeated }) });
    },
  );

  /** The warm-up coach_me asks first in this student session (last session's position), or null. */
  function warmUpOf(player: string, student: StudentFile | undefined): { gameId: string; ply: number } | null {
    if (!student) return null;
    return lastSessionSummary(student, openIndex(player, student) ?? student.sessions.length)?.warmUp ?? null;
  }

  /** Boards the student has tried at any time (position keys): their quick fixes show the answer. */
  function triedBoards(student: StudentFile | undefined, boardOf: (gameId: string, ply: number) => string | null): Set<string> {
    const out = new Set<string>();
    for (const s of student?.sessions ?? []) {
      for (const t of s.tried) {
        const b = t.key ?? boardOf(t.gameId, t.ply);
        if (b) out.add(b);
      }
    }
    return out;
  }

  registerAppTool(
    server,
    'coach_report',
    {
      title: 'Show the report card',
      description:
        "Shows the player's report card on the board: where their points go (ranked bars of the share of winning chances " +
        "given away), one hero sentence, one context line, this week's focus with up to three lesson boards (no answers), " +
        'the drills done this week, and quick fixes (positions they keep getting wrong; answers hidden until tried). Call ' +
        'it once coach_diagnosis is done, with the same arguments; while games are still being analysed the board says so. ' +
        `The boards are checked with a deeper search first (at most ${REPORT_SEARCH_BUDGET} new searches per call for the ` +
        'lesson boards and quick fixes together; results are kept, so later calls are quick and get further). Also returns ' +
        'the card as text (show that only if the board did not appear). ' +
        "The boards are practice positions: coach_ask_position asks them; never name their moves first. " +
        NO_INVENTED_FACTS,
      inputSchema: {
        usernames: usernamesSchema,
        accounts: accountsSchema,
        timeClass: timeClassSchema,
        maxGames: maxGamesSchema,
        asOf: asOfSchema,
      },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async (args) => {
      const o = await diagnosisFor(args);
      if (!o.ready) {
        if (!o.waiting) return o.result;
        const message =
          o.total > 0
            ? `Analysed ${o.done} of ${o.total} games. Ask for the report again in a minute.`
            : 'Getting your games from Chess.com. Ask for the report again in a minute.';
        return reply(message, { ...toStatusView('Still analysing your games', message, { done: o.done, total: o.total }) });
      }
      const a = o.a;
      const lesson = lessons.get(o.player)!;
      const student = studentOrNothing(o.player);
      const byId = new Map(a.games.map((c) => [c.game.id, c]));
      const boardOf = boardKeyFinder(byId);
      const notes: string[] = [];

      // One budget of searches that really run, for the lesson boards and the quick fixes together;
      // the lesson boards may use at most ASK_SEARCH_BUDGET of it, so quick fixes always get some.
      const budget = searchBudget(REPORT_SEARCH_BUDGET, displaySearches);

      // This week's lesson boards: the first teachable positions of the focus pool, checked lazily.
      const focus = hasLeakFocus(a.leak);
      let walk: PoolWalk | null = null;
      if (focus) {
        try {
          const lessonBudget = searchBudget(ASK_SEARCH_BUDGET, displaySearches, budget);
          walk = await walkPool(lesson, REPORT_LESSON_BOARDS, exclusions(lesson, student, false), lessonBudget);
        } catch (e) {
          notes.push(`The lesson positions could not be checked just now (${msg(e)}), so the card shows none.`);
        }
      }
      const boards = walk?.found ?? [];

      // Quick fixes: the positions the player keeps getting wrong, the answer shown only once tried.
      // A board that is also asked as a question (one of this card's lesson boards, or the warm-up
      // the session re-asks first) is left out, so the card never shows its moves next to it.
      const asked = new Set(boards.map((b) => b.ref.board));
      const warm = warmUpOf(o.player, student);
      const warmBoard = warm ? boardOf(warm.gameId, warm.ply) : null;
      if (warmBoard) asked.add(warmBoard);
      let quickFixes: QuickFix[] = [];
      try {
        const positions =
          a.d.repeated.length > 0 ? await buildReportPositions(a.d, a.games, deepEngine(), student, { skip: asked, budget }) : [];
        const tried = triedBoards(student, boardOf);
        quickFixes = positions.map((p) => quickFixFromPosition(p, tried.has(positionKey(p.fen))));
      } catch (e) {
        notes.push(`The quick fixes could not be checked just now (${msg(e)}), so the card shows none.`);
      }

      const pool = poolOf(a);
      const done = drillsDone(student, pool, boardOf, now());
      const view = toReportView(a.leak, {
        positions: boards.map((b) => ({ fen: b.facts.fenBefore, orientation: b.facts.mover, prompt: poolPrompt(b.ref) })),
        drillsDone: done,
        drillsTotal: LEAK_CFG.drillsPerWeek,
        quickFixes,
        cta: DEFAULT_REPORT_CTA,
        query: echoQuery(args),
      });

      const context = areaContext(a.d);
      const lines = [
        `Report card: ${view.hero.headline}${view.hero.sub ? ` ${view.hero.sub}` : ''}`,
        '',
        leakDiagnosisText(a.leak, { context, gamesByAccount: a.byAccount, repeated: a.d.repeated.length }),
        '',
      ];
      if (focus) {
        const n = boards.length;
        let ready = `This week: ${view.focus.title}. ${n === 0 ? 'No lesson positions are' : `${plural(n, 'lesson position')} ${n === 1 ? 'is' : 'are'}`} ready on the card`;
        if (walk?.capped && n < REPORT_LESSON_BOARDS) {
          ready += ` so far (the deeper check looked at ${plural(walk.checks, 'new position')} this time)`;
        }
        lines.push(`${ready}. Drills this week: ${view.focus.drillsDone} of ${view.focus.drillsTotal}.`);
        if (n > 0) {
          lines.push(
            "They are practice positions: don't name or show any move in them; coach_ask_position (without a gameId) asks " +
              'them one at a time, each checked with a deeper search first.',
          );
        }
      } else {
        lines.push('No focus yet, so there is nothing to practise: say so plainly.');
      }
      if (quickFixes.length > 0) {
        const shown = quickFixes.filter((q) => q.revealed).length;
        lines.push(
          `Quick fixes on the card: ${plural(quickFixes.length, 'position')} you keep reaching and getting wrong; ` +
            (shown > 0 ? `${shown} already tried (its answer shows), the others hidden until tried. ` : 'answers hidden until tried. ') +
            "Don't name any move in them.",
        );
      }
      if (budget.ranOut || walk?.capped) {
        lines.push(
          `This call stopped at its limit of deeper searches (${REPORT_SEARCH_BUDGET} at most), so the card shows what is ` +
            'ready; more positions get ready next time (results are kept, so they cost nothing again).',
        );
      }
      lines.push(
        'The games behind each finding: coach_examples with these accounts and source thrownWins (the hero), a ' +
          "situation's key (a bar) or quickFix with a quick fix's key (all in the card's data).",
      );
      lines.push(...notes);
      if (o.skipped) lines.push(`${plural(o.skipped, 'game')} could not be read and ${o.skipped === 1 ? 'was' : 'were'} left out.`);
      return reply(lines.join('\n'), { ...view });
    },
  );

  registerAppTool(
    server,
    'coach_examples',
    {
      title: 'Games behind a finding',
      description:
        "Lists the player's own games behind one finding of the report, newest first, a page at a time (at most " +
        `${EXAMPLES_MAX_LIMIT}): source 'thrownWins' (games they were clearly winning and lost; the slip is their biggest ` +
        "drop after that), a situation ('clock', 'winning', 'losing', 'opening', 'endgame', 'middlegame': each game's " +
        "costliest move there), or 'quickFix' with a quick fix's key from coach_report (the games that reached that " +
        'position). Each row has the date, the opponent\'s rating, the result, the move number and the move played, the ' +
        "player's win chance before and after it (quick check, approximate), and its gameId and ply. No best moves and no " +
        'engine lines: to practise one, call coach_ask_position with its gameId and ply. Pass the same accounts and time ' +
        "class as the report (the card's query). " +
        NO_INVENTED_FACTS,
      inputSchema: {
        source: z.enum(EXAMPLE_SOURCES as [ExampleSource, ...ExampleSource[]]).describe('Which finding: thrownWins, a situation key, or quickFix'),
        key: z.string().trim().min(1).max(100).optional().describe("With source 'quickFix': the quick fix's key from coach_report"),
        offset: z.number().int().min(0).default(0).describe('How many rows to skip (for the next page)'),
        limit: z.number().int().min(1).default(EXAMPLES_MAX_LIMIT).describe(`Rows per page; at most ${EXAMPLES_MAX_LIMIT}`),
        usernames: usernamesSchema,
        accounts: accountsSchema,
        timeClass: timeClassSchema,
        maxGames: maxGamesSchema,
        asOf: asOfSchema,
      },
      _meta: { ui: { resourceUri: BOARD_URI, visibility: ['model', 'app'] } },
    },
    async ({ source, key, offset, limit, ...args }) => {
      const o = await diagnosisFor(args);
      if (!o.ready) {
        if (!o.waiting) return o.result;
        const message = 'Your games are still being analysed. Ask again in a minute.';
        return reply(message, { ...toStatusView('Still analysing your games', message, { done: o.done, total: o.total }) });
      }
      const page = examplesPage(o.a.games, o.a.usernames, { source, key, offset, limit });
      if ('error' in page) return failure(page.error);
      return reply(examplesText(page), { ...page });
    },
  );

  registerAppTool(
    server,
    'coach_ask_position',
    {
      title: 'Ask the player a position',
      description:
        "Shows a position from the player's games as a question: the board before their move, with no arrows, no " +
        "evaluation and no hint (try first). Without gameId and ply it picks the next practice position for this week's " +
        'focus (from the last coach_report or coach_diagnosis), skipping ones already asked this session, up to about six ' +
        'a session. With them it asks that position: the warm-up from coach_student, or a position the player picked from ' +
        "their games (it must be the player's own move). Each position is checked with a deeper search first and only asked " +
        `if the game move really was a mistake there; at most ${MAX_DEEP_CHECKS} new positions are searched per call, so this ` +
        'can take a few seconds. The line above the board is "You\'re winning here. Find the move that keeps it." only when ' +
        'the deeper check says the player is winning there, else "Find a better move here." When the board says no ' +
        'position is ready, there are no more, the move held up, or it is ' +
        'enough for today, say so honestly. Never name or hint at a move or evaluation until coach_check_move has scored ' +
        "the player's try.",
      inputSchema: {
        gameId: z.string().min(1).optional().describe('Game id of a position to ask (with ply); leave out for the next practice position'),
        ply: z.number().int().min(0).optional().describe("0-based ply of the player's own move (with gameId)"),
        username: optionalUsername,
      },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ gameId, ply, username }) => {
      if ((gameId === undefined) !== (ply === undefined)) {
        return failure('Give both gameId and ply, or neither (for the next practice position).');
      }
      let player: string | null;
      try {
        player = playerFor(username);
      } catch (e) {
        return failure(msg(e));
      }
      const lesson = player ? lessons.get(player) : undefined;
      if (lesson) lessonSession(lesson);
      // The line above the board comes from the deep check only (never from the caller), so
      // "You're winning here" is never shown over a position that isn't winning at depth.
      const ask = (facts: PositionFacts, line: string) => {
        lesson?.asked.add(refKey(facts.gameId, facts.ply));
        return reply(questionText(facts, line), { ...toQuestionView(facts, line) });
      };
      /** The calm card for an ending (no board, no error), with the model's instructions in the text. */
      const status = (title: string, message: string, next: string) => reply(`${message} ${next}`, { ...toStatusView(title, message) });

      if (gameId !== undefined && ply !== undefined) {
        const own = ownPosition(gameId, ply);
        if ('error' in own) return own.error;
        // A repeated position is judged by the repeated-position line, anything else as a mistake or blunder.
        const fen = gamePlies(own.c)?.[ply]?.fenBefore;
        const kind: PracticeKind = lesson && fen && lesson.a.d.repeated.some((r) => r.key === positionKey(fen)) ? 'repeated' : 'mistake';
        let facts: PositionFacts;
        try {
          facts = await deepCheck(own.c, ply, deepEngine());
        } catch (e) {
          return failure(`Could not check this position: ${msg(e)}`);
        }
        if (!isTeachable(kind, own.c.analysis.plies[ply].classification, facts)) {
          return status(
            'Your move held up',
            'On a deeper look your move here was fine. Pick another example.',
            "Tell the player so plainly, without naming any move: this position isn't worth practising. Pick another " +
              'example, or call coach_ask_position without gameId and ply for the next practice position.',
          );
        }
        // Asked by reference: "keeps the win" only when the deep check says the player is winning there.
        return ask(facts, lessonPrompt(facts));
      }

      if (!lesson) {
        return failure('No lesson yet: call coach_report (or coach_diagnosis) for this player first, then ask again.');
      }
      if (!hasLeakFocus(lesson.a.leak)) {
        return status('Nothing to practise yet', 'There is no focus yet, so there is nothing to practise.', 'Say so plainly.');
      }
      if (lesson.picked >= SESSION_POSITIONS) {
        return status(
          'Enough for today',
          `That's enough practice for one session (${plural(lesson.picked, 'position')}).`,
          'Move on to the rule of thumb.',
        );
      }
      let walk: PoolWalk;
      try {
        walk = await walkPool(
          lesson,
          1,
          exclusions(lesson, studentOrNothing(lesson.player), true),
          searchBudget(ASK_SEARCH_BUDGET, displaySearches),
        );
      } catch (e) {
        return failure(`Could not check the next position: ${msg(e)}`);
      }
      const found = walk.found[0];
      if (!found) {
        if (walk.capped) {
          return status(
            'No position ready yet',
            `No ready position was found this time: the deeper check looked at ${plural(walk.checks, 'position')} and ` +
              'none of them was ready to ask.',
            'Call coach_ask_position again to check the next ones, or move on; never show a position that was not checked.',
          );
        }
        return status(
          'No more positions',
          `No more practice positions for this focus in these games (${plural(lesson.picked, 'position')} this session).`,
          'Say so honestly and move on to the rule of thumb.',
        );
      }
      lesson.picked++;
      // From the focus pool: "keeps the win" only for a keep-the-win position, never for the clock or a leak.
      return ask(found.facts, poolPrompt(found.ref));
    },
  );

  registerAppTool(
    server,
    'coach_check_move',
    {
      title: "Score the player's try",
      description:
        'Scores the move the player tried in a position from coach_ask_position, with a deeper search, records it in ' +
        "their student file (only the first try at a position counts), and shows it on the board against Stockfish's " +
        'best move. Call it once the player has given their move and their reason. Returns the verdict (right means ' +
        `losing at most ${REPEAT_CFG.wrongLossPts}% win chance against the best move), both win chances, the best line, ` +
        "the opponent's reply to their move, and the game move's numbers. " +
        NO_INVENTED_FACTS,
      inputSchema: {
        gameId: z.string().min(1).describe('The gameId from coach_ask_position'),
        ply: z.number().int().min(0).describe('The ply from coach_ask_position'),
        moveSan: z.string().trim().min(1).describe('The move the player tried, in SAN as they gave it (e.g. "Nf6", "O-O", "exd5")'),
        username: optionalUsername,
      },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ gameId, ply, moveSan, username }) => {
      const own = ownPosition(gameId, ply);
      if ('error' in own) return own.error;
      const illegal = failure(
        `"${moveSan}" is not a legal move here, or it is ambiguous (which piece?). ${capitalize(own.c.game.myColor)} is to move. ` +
          'Ask the player for their move again; nothing was recorded.',
      );
      // Checked before any engine is started.
      if (!legalAttempt(own.c, ply, moveSan)) return illegal;
      let player: string | null;
      try {
        player = playerFor(username, own.c);
      } catch (e) {
        return failure(msg(e));
      }
      let r: CheckResult;
      try {
        r = await checkMove(own.c, ply, moveSan, deepEngine());
      } catch (e) {
        return failure(`Could not check this move: ${msg(e)}`);
      }
      if (!r.legal) return illegal;
      const lesson = player ? lessons.get(player) : undefined;
      if (lesson) {
        lessonSession(lesson);
        lesson.asked.add(refKey(gameId, ply));
      }

      const key = positionKey(r.facts.fenBefore);
      // The numbers every channel shows: a wrong verdict near the line never reads as within it.
      const shown = shownNumbers(r);
      const keyOf = boardKeyFinder(new Map((lesson?.a.games ?? []).map((c) => [c.game.id, c])));
      let tally: string;
      try {
        if (!player) throw new Error('no username');
        let recorded = true;
        const s = editStudent(player, (st) => {
          if (triedBoard(st.sessions[st.sessions.length - 1], key, keyOf)) {
            recorded = false;
            return st;
          }
          return recordAttempt(st, {
            gameId,
            ply,
            moveSan: r.attempt.moveSan,
            correct: r.correct,
            lossPts: shown.lossPts,
            key,
          });
        });
        const firsts = firstTries(s.sessions[s.sessions.length - 1]);
        const count = `${firsts.filter((t) => t.correct).length} of ${firsts.length} right this session`;
        tally = recorded
          ? `Recorded in ${player}'s student file: ${count}.`
          : `Not recorded: only your first try at a position counts (${count}).`;
      } catch (e) {
        tally = `Not recorded in the student file: ${msg(e)}.`;
      }
      // The board agrees with the verdict: the position's value is the shown best win chance and, when
      // the try is the game move, its win chance after is the shown one too, to one decimal near the line.
      const shownFacts = { ...r.facts, winBefore: shown.bestWin, ...(r.isGameMove ? { winAfter: shown.attemptWin } : {}) };
      return reply(checkText(r, tally), {
        ...toAnswerView(shownFacts, r.attempt, shown.decimals && r.isGameMove),
        correct: r.correct,
        lossPts: shown.lossPts,
        attemptWin: shown.attemptWin,
        bestWin: shown.bestWin,
      });
    },
  );

  server.registerTool(
    'coach_note_thinking',
    {
      title: 'Note a thinking error',
      description:
        "Saves, in the player's student file, a thinking error you noticed behind their reason (one short plain sentence, " +
        'e.g. "didn\'t ask what the last move threatened"), and/or the session\'s one rule of thumb for live games. ' +
        'Name no moves in either: the next session reads them out after the warm-up try.',
      inputSchema: {
        note: z.string().trim().min(1).max(300).optional().describe('The thinking error, in one short sentence, naming no moves'),
        rule: z.string().trim().min(1).max(300).optional().describe("This session's rule of thumb for live games"),
        username: optionalUsername,
      },
    },
    async ({ note, rule, username }) => {
      if (!note && !rule) return failure('Give a note (a thinking error), a rule (the rule of thumb), or both.');
      let player: string | null;
      try {
        player = playerFor(username);
      } catch (e) {
        return failure(msg(e));
      }
      if (!player) return failure("Give the player's username (no player in this session yet).");
      let s: StudentFile;
      try {
        s = editStudent(player, (st) => {
          let out = note ? addThinkingNote(st, note) : st;
          if (rule) out = setRule(out, rule);
          return out;
        });
      } catch (e) {
        return failure(`Could not save to the student file: ${msg(e)}`);
      }
      const cur = s.sessions[s.sessions.length - 1];
      return reply(
        `Saved in ${player}'s student file: ${plural(cur.thinkingNotes.length, 'thinking note')} this session` +
          `${cur.rule ? '; rule of thumb set' : ''}.`,
        { username: player, thinkingNotes: cur.thinkingNotes, rule: cur.rule },
      );
    },
  );

  server.registerTool(
    'coach_student',
    {
      title: 'What the coach remembers',
      description:
        "Reads the player's student file for the warm-up: one position from last session to ask again first, then (after " +
        "the player's try) the last session's focus, how many positions they got right on the first try, the thinking " +
        'errors noted and the rule of thumb.',
      inputSchema: { username: optionalUsername },
    },
    async ({ username }) => {
      let player: string | null;
      try {
        player = playerFor(username);
      } catch (e) {
        return failure(msg(e));
      }
      if (!player) return failure("Give the player's username (no player in this session yet).");
      let s: StudentFile;
      try {
        s = loadStudent(player);
      } catch (e) {
        return failure(`Could not read the student file: ${msg(e)}`);
      }
      const cur = openIndex(player, s);
      const last = lastSessionSummary(s, cur ?? s.sessions.length);
      const lines: string[] = [];
      if (!last) {
        lines.push(`No earlier sessions for ${player}: this is the first one, so skip the warm-up.`);
      } else {
        if (last.warmUp) {
          lines.push(
            `Warm-up first: ask gameId ${last.warmUp.gameId}, ply ${last.warmUp.ply} again with coach_ask_position (try first). ` +
              "Read out the rest only after the player's try.",
          );
        }
        lines.push(last.text);
      }
      const earlier = s.sessions.filter((x, i) => i !== cur && (x.tried.length > 0 || x.thinkingNotes.length > 0)).length;
      if (earlier > 1) lines.push(`Sessions so far: ${earlier}.`);
      const nowSession = cur === null ? null : s.sessions[cur];
      if (nowSession && nowSession.tried.length > 0) {
        const firsts = firstTries(nowSession);
        lines.push(`This session so far: ${firsts.filter((t) => t.correct).length} of ${firsts.length} right.`);
      }
      return reply(lines.join('\n'), {
        username: player,
        earlierSessions: earlier,
        last: last
          ? { at: last.at, focus: last.focus, right: last.right, tried: last.tried, thinkingNotes: last.thinkingNotes, rule: last.rule }
          : null,
        warmUp: last?.warmUp ?? null,
      });
    },
  );

  server.registerTool(
    'coach_engine_status',
    {
      title: 'Engine status',
      description: 'Where Stockfish is, whether it is running, its settings, and the analysis jobs of this session.',
      inputSchema: {},
    },
    async () => {
      const info = deps.engineInfo();
      const jobs = [...tracked.values()].map((t) => {
        const st = t.result ? deps.runner.status(t.result.jobId) : null;
        return {
          usernames: t.q.usernames,
          timeClass: t.q.timeClass,
          maxGames: t.q.maxGames,
          state: st ? st.state : t.error ? 'error' : 'fetching',
          done: st?.done ?? 0,
          total: st?.total ?? 0,
          error: st?.error ?? t.error ?? null,
        };
      });
      const analysis = { ...ENGINE_CFG, ...info.analysis };
      const display = { ...ENGINE_CFG, ...DISPLAY_CFG, ...info.display };
      const run = (r: boolean) => (r ? 'running' : 'not running');
      const lines = [
        '| Item | Value |',
        '|---|---|',
        `| Stockfish | ${info.stockfishPath} (${info.binaryFound ? 'found' : 'NOT FOUND: install with brew install stockfish'}) |`,
        `| Analysis engine | ${run(analysis.running)}; ${analysis.movetimeMs} ms per position, MultiPV ${analysis.multiPv}, ` +
          `${analysis.threads} threads, ${analysis.hashMb} MB hash; ${analysis.positionsSearched} positions searched |`,
        `| Board engine (deep check) | ${run(display.running)}; depth ${display.depth}, ` +
          `${display.threads} thread${display.threads === 1 ? '' : 's'}, MultiPV ${display.multiPv} (same answer every time); ` +
          `${display.positionsSearched} positions searched |`,
        ...(jobs.length === 0
          ? ['| Analysis jobs | none this session |']
          : jobs.map(
              (j) =>
                `| Job ${j.usernames.join(', ')} ${j.timeClass} ${j.maxGames} | ${j.state}, ${j.done} of ${j.total} games` +
                `${j.error ? `: ${j.error}` : ''} |`,
            )),
      ];
      return reply(lines.join('\n'), {
        stockfishPath: info.stockfishPath,
        binaryFound: info.binaryFound,
        analysis,
        display,
        jobs,
      });
    },
  );

  server.registerPrompt(
    'coach_me',
    {
      title: 'Coach me',
      description: 'A coaching session on your recent Chess.com games: report card, then positions you try first',
      argsSchema: { username: z.string().min(1).describe('Chess.com username') },
    },
    ({ username }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: coachMeText(username) } }],
    }),
  );
}
