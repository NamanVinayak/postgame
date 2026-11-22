/**
 * The coach's MCP tools and the `coach_me` prompt. Every tool answers with a plain-text
 * version (for any host, and for the model) plus `structuredContent`. Tools linked to the
 * board widget (BOARD_URI) return a `CoachView` as `structuredContent`.
 *
 * Every move and number shown comes from a tool: the stats (diagnosis), the game record, or
 * a deep engine search (DISPLAY_CFG) made just before a position is shown. Nothing model-facing
 * carries a quick-search (ENGINE_CFG) best move; the quick check's win-% losses of repeated
 * positions are labelled approximate.
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
import { deepDisagrees, deepPositionFacts, examplePositions, repeatedRefs, type PositionFacts } from '../coaching/explain';
import {
  boardKeyFinder,
  checkMove,
  firstTeachable,
  isTeachable,
  legalAttempt,
  practiceExclusions,
  refKey,
  samePatternPositions,
  triedBoard,
  type CheckResult,
  type PracticeKind,
} from '../coaching/lesson';
import { buildReportPositions } from '../coaching/reportPositions';
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
import { ENGINE_CFG, DISPLAY_CFG, POSTGAME_URL, REPEAT_CFG, SOURCE_CFG, STATS_CFG } from '../config';
import { AREA_NAMES, gamePlies } from '../diagnosis/areas';
import { diagnose, type AreaFinding, type Diagnosis } from '../diagnosis/diagnose';
import { positionKey, type RepeatedPosition } from '../diagnosis/repeated';
import { guardDisplayEngine, memoDisplayEngine, type DisplayEngine, type SearchMemo } from '../engine/displayEngine';
import { BOARD_URI } from './boardResource';
import { DEFAULT_REPORT_CTA, toAnswerView, toQuestionView, toReportView, type ReportPosition } from './views';

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
  /** The diagnosis itself (tests count calls); default `diagnose`. */
  diagnose?: typeof diagnose;
  /** The clock for student sessions (tests move it forward); default `Date.now`. */
  now?: () => number;
}

const EXAMPLES = 3;
/** Same-pattern candidates considered per coach_ask_position call. */
const ASK_CANDIDATES = 12;
/** Deep checks per coach_ask_position call (about 3 s each) before it gives up for now. */
const ASK_MAX_CHECKS = 4;
/** A student's session ends after this long without a tool writing to it. */
const SESSION_IDLE_MS = 3 * 60 * 60 * 1000;
const DEFAULT_QUESTION = 'What would you play here, and what were you worried about?';
/** Diagnoses kept for repeat calls (one per query set and set of cached games). */
const MEMO_SIZE = 8;
/** Repeated positions written out in the text (the focus ones come first); all are in structuredContent. */
const MAX_REPEATED_LINES = 10;

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

// ---- small helpers ----

type Started = { jobId: string; total: number; cached: number };
type Result = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct1 = (x: number) => x.toFixed(1);
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

// ---- the diagnosis as the model sees it ----

/** Plain words for an area's label, as the player reads them. */
export function verdict(a: AreaFinding): string {
  switch (a.label) {
    case 'gap':
      // Statistically clear, but a gap under the meaningful size is said to be small.
      return a.gapPts < STATS_CFG.meaningfulGapPts ? 'small but real weak spot' : 'weak spot';
    case 'notYourProblem':
      return 'not a weak spot';
    case 'noClearDifference':
      return 'too close to call';
    case 'notEnoughData':
      return 'not enough data';
  }
}

/** A position worth showing, by reference only: no engine moves or numbers until it is deep-checked. */
export interface ExampleRef {
  gameId: string;
  ply: number;
  moveNumber: number;
  mover: 'white' | 'black';
  playedSan: string;
  gameUrl: string;
}

function toRef(f: PositionFacts): ExampleRef {
  return {
    gameId: f.gameId,
    ply: f.ply,
    moveNumber: Math.floor(f.ply / 2) + 1,
    mover: f.mover,
    playedSan: f.playedSan,
    gameUrl: f.gameUrl,
  };
}

/**
 * A repeated position without the quick search's best move. The win-% losses come from the
 * quick check, so they are named approximate. `example` opens one sighting by the player.
 */
export interface RepeatedView {
  key: string;
  fen: string;
  movesFromStart: string[];
  seen: number;
  wrong: number;
  approxAvgLossPts: number;
  usual: { move: string; times: number; approxLossPts: number }[];
  gameIds: string[];
  example: { gameId: string; ply: number } | null;
}

/** Built field by field, so the engine's `best` can't slip through. */
function toRepeatedView(r: RepeatedPosition, example: { gameId: string; ply: number } | null): RepeatedView {
  return {
    key: r.key,
    fen: r.fen,
    movesFromStart: r.movesFromStart,
    seen: r.seen,
    wrong: r.wrong,
    approxAvgLossPts: r.avgLossPts,
    usual: r.usual.map((u) => ({ move: u.move, times: u.times, approxLossPts: u.lossPts })),
    gameIds: r.gameIds,
    example,
  };
}

/** The diagnosis as returned to the model: everything but the repeated positions' quick-search best move. */
export type DiagnosisView = Omit<Diagnosis, 'repeated'> & {
  repeated: RepeatedView[];
  examples: ExampleRef[];
  /** Games per account (only when several accounts are diagnosed together). */
  gamesByAccount: { username: string; games: number }[];
};

export function diagnosisView(
  d: Diagnosis,
  examples: ExampleRef[],
  refs: ({ gameId: string; ply: number } | null)[],
  gamesByAccount: { username: string; games: number }[] = [],
): DiagnosisView {
  const { repeated, ...rest } = d;
  return { ...rest, repeated: repeated.map((r, i) => toRepeatedView(r, refs[i] ?? null)), examples, gamesByAccount };
}

const moveLabel = (moveNumber: number, mover: 'white' | 'black', san: string) =>
  `${moveNumber}${mover === 'white' ? '.' : '...'} ${san}`;

/** Diagnosis notes that restate the focus; the text prints its own single Focus line instead. */
const RESTATES_FOCUS = /^(Focus:|No focus yet)/;

/**
 * The diagnosis as text: a table (area, verdict in plain words, the player's %, players at
 * their rating %, game count), one focus line, the notes, the repeated positions (game moves
 * and approximate losses, each with a reference to open it) and example positions by reference.
 * Rows without enough data show no percentages.
 *
 * With `practice` (a coaching session is running), the repeated positions are today's practice
 * positions: they are listed without the player's moves there and without references, and the
 * example positions are left out, so nothing in the text gives away an answer before the
 * player tries (coach_ask_position asks them).
 */
export function diagnosisText(v: DiagnosisView, opts: { practice?: boolean } = {}): string {
  const practice = opts.practice ?? false;
  const lines: string[] = [];
  lines.push(
    `Diagnosis for ${v.usernames.join(', ')}: ${plural(v.games, `${v.timeClass} game`)}. Each row compares the share of ` +
      'your moves that were serious mistakes (a mistake or a blunder) with the same share for players at your rating, ' +
      'your opponents in the same games.',
  );
  if (v.gamesByAccount.length > 1) {
    lines.push(`Games per account: ${v.gamesByAccount.map((a) => `${a.username} ${a.games}`).join(', ')}.`);
  }
  lines.push('');
  lines.push('| Area | Verdict | You % | Players at your rating % | Games |');
  lines.push('|---|---|---|---|---|');
  for (const a of v.areas) {
    const known = a.label !== 'notEnoughData';
    lines.push(
      `| ${capitalize(AREA_NAMES[a.area])} | ${verdict(a)} | ${known ? pct1(a.myRate) : '–'} | ` +
        `${known ? pct1(a.oppRate) : '–'} | ${a.games} |`,
    );
  }
  lines.push('');

  const focus = v.focus;
  if (focus?.kind === 'area') {
    const a = v.areas.find((x) => x.area === focus.area);
    lines.push(`Focus: ${AREA_NAMES[focus.area]}${a ? ` (${verdict(a)}, ${plural(a.games, 'game')})` : ''}.`);
  } else if (focus?.kind === 'repeated') {
    lines.push(
      `Focus: the ${focus.keys.length === 1 ? 'position' : `${focus.keys.length} positions`} you keep getting wrong ` +
        '(marked [focus] below).',
    );
  } else {
    lines.push('Focus: none yet: no area shows a clear gap and no position keeps going wrong.');
  }

  const notes = v.notes.filter((n) => !RESTATES_FOCUS.test(n));
  if (notes.length > 0) {
    lines.push('', 'Notes:');
    for (const n of notes) lines.push(`- ${n}`);
  }

  if (v.repeated.length > 0) {
    lines.push(
      '',
      practice
        ? "Positions you keep getting wrong (losses are approximate, from the quick check). These are today's practice " +
            "positions; coach_ask_position asks them, so don't name or show any move in them before the player has tried:"
        : 'Positions you keep getting wrong (your moves from the games; losses are approximate, from the quick check; ' +
            'open one with coach_explain_position before naming its best move):',
    );
    const focusKeys = new Set(focus?.kind === 'repeated' ? focus.keys : []);
    v.repeated.slice(0, MAX_REPEATED_LINES).forEach((r, i) => {
      const where = r.movesFromStart.length > 0 ? `After ${formatLineSan(r.movesFromStart, 0)}` : 'In the starting position';
      const usual = r.usual
        .map((u) =>
          u.times === 1
            ? `${u.move} once (about ${Math.round(u.approxLossPts)}%)`
            : `${u.move} ${u.times} times (about ${Math.round(u.approxLossPts)}% each time)`,
        )
        .join(', ');
      lines.push(
        `${i + 1}. ${focusKeys.has(r.key) ? '[focus] ' : ''}${where}: you had to move here in ${plural(r.seen, 'game')} ` +
          `and went wrong ${plural(r.wrong, 'time')}, losing about ${Math.round(r.approxAvgLossPts)}% win chance each time (quick check).` +
          `${usual && !practice ? ` Your moves there: ${usual}.` : ''}` +
          `${r.example && !practice ? ` To show it: gameId ${r.example.gameId}, ply ${r.example.ply}.` : ''}`,
      );
    });
    const more = v.repeated.length - MAX_REPEATED_LINES;
    if (more > 0) lines.push(`…and ${plural(more, 'more position')} like these, in the structured data.`);
  }

  if (v.examples.length > 0 && !practice) {
    lines.push('', 'Example positions for the focus (show one with coach_explain_position, using its gameId and ply):');
    for (const x of v.examples) {
      lines.push(
        `- gameId ${x.gameId}, ply ${x.ply}: you played ${moveLabel(x.moveNumber, x.mover, x.playedSan)} as ` +
          `${capitalize(x.mover)}. Game: ${x.gameUrl}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * The diagnosis as returned while a coaching session runs: the same, minus everything that would
 * answer a practice position before the player tries it (the moves played in the repeated
 * positions, their references and the example positions).
 */
export function practiceView(v: DiagnosisView): DiagnosisView {
  return { ...v, repeated: v.repeated.map((r) => ({ ...r, usual: [], example: null })), examples: [] };
}

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

/** The diagnosis focus in plain words, as the student file stores it. */
export function focusLabel(d: Diagnosis): string | null {
  const f = d.focus;
  if (f?.kind === 'area') return AREA_NAMES[f.area];
  if (f?.kind === 'repeated') {
    return f.keys.length === 1 ? 'the position you keep getting wrong' : `the ${f.keys.length} positions you keep getting wrong`;
  }
  return null;
}

/** Areas as the report headline names them. */
const HEADLINE_AREA: Record<string, string> = {
  opening: 'your openings',
  middlegame: 'your middlegames',
  endgame: 'your endgames',
  converting: 'finishing off won positions',
  defending: 'holding worse positions',
  timePressure: 'moves when your clock is low',
};

/**
 * The report card's headline and the sentence under it, in plain words from the diagnosis,
 * with the game count. `missions` is how many focus positions the card shows.
 * - A clear gap (the focus area): it is named; under STATS_CFG.meaningfulGapPts it is "small but real".
 * - No gap but enough games: "Your rating is honest", and the positions where points leak.
 * - Too few games to judge any area: says so.
 */
export function reportWords(d: Diagnosis, missions: number): { headline: string; subhead: string } {
  const games = plural(d.games, `${d.timeClass} game`);
  const f = d.focus;
  const gap = f?.kind === 'area' ? d.areas.find((a) => a.area === f.area && a.label === 'gap') : undefined;
  if (gap) {
    const name = HEADLINE_AREA[gap.area] ?? AREA_NAMES[gap.area];
    return {
      headline:
        gap.gapPts < STATS_CFG.meaningfulGapPts ? `A small but real weak spot: ${name}.` : `Your weak spot: ${name}.`,
      subhead:
        `There, ${pct1(gap.myRate)}% of your moves are serious mistakes, against ${pct1(gap.oppRate)}% for players ` +
        `at your rating (${games}).`,
    };
  }
  if (d.areas.length > 0 && d.areas.every((a) => a.label === 'notEnoughData')) {
    return {
      headline: 'Not enough games yet to judge.',
      subhead: `${capitalize(games)} so far; each part of the game needs at least ${STATS_CFG.minGames} games.`,
    };
  }
  return {
    headline:
      missions > 0 ? `Your rating is honest. Your points leak from ${plural(missions, 'position')}.` : 'Your rating is honest.',
    subhead: `Against players at your rating, no part of your game stands out (${games}).`,
  };
}

/**
 * A question position as text: where it is and the position, never the game move, the best
 * move, a win % or how the move was graded (try-first).
 */
export function questionText(f: PositionFacts, prompt: string): string {
  const side = capitalize(f.mover);
  return [
    `Question position: gameId ${f.gameId}, ply ${f.ply} (move ${Math.floor(f.ply / 2) + 1}, ${side} to move; the player was ${side}).`,
    `Position (FEN): ${f.fenBefore}`,
    `The board shows the position only, with no hint. Ask: "${prompt}" Then wait for the player's move and reason, ` +
      'without naming or hinting at any move or evaluation. Then call coach_check_move with this gameId and ply and their move.',
  ].join('\n');
}

/** A scored attempt as text: the verdict, both win chances, the lines, and the game move's numbers labelled as such. */
export function checkText(r: Extract<CheckResult, { legal: true }>, tally: string | null): string {
  const f = r.facts;
  const side = capitalize(f.mover);
  const tried = r.attempt.moveSan;
  // Near the line, one decimal, so "loses about 5%" never sits next to "right means at most 5%".
  const loss = !r.correct && r.lossPts < REPEAT_CFG.wrongLossPts + 0.5 ? r.lossPts.toFixed(1) : String(Math.round(r.lossPts));
  const bestSan = f.bestSan ?? f.playedSan;
  const bestUci = f.bestUci ?? f.playedUci;
  const lines = [
    `Position: gameId ${f.gameId}, ply ${f.ply} (move ${Math.floor(f.ply / 2) + 1}, ${side} to move).`,
    `The player tried ${tried} (${r.attempt.moveUci}).`,
    r.isBest
      ? "Right: that is Stockfish's best move."
      : r.correct
        ? `Right: it is within ${REPEAT_CFG.wrongLossPts}% of the best move (it loses about ${loss}%).`
        : `Not right: it loses about ${loss}% win chance against the best move.`,
    `Your move keeps about ${Math.round(r.attemptWin)}% win chance; the best move keeps ${Math.round(r.bestWin)}%.`,
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
 * The coach's script for one session (spec §6b, steps 1–8), plus the rules. Only names tools
 * that exist; drills and the re-check get their own tools later.
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
      'analysed, tell me how far it got and check again shortly). Then call coach_report; the board shows the report card. ' +
      "Add a one- or two-sentence headline of your own, nothing more; give the table in text only if the board didn't show. " +
      "The card's positions are today's practice: don't name their moves.",
    '2. Warm-up. Call coach_student. If I had an earlier session, first ask its warm-up position again with ' +
      'coach_ask_position (that gameId and ply), the same way as step 4. Only after my try, tell me the line from last time ' +
      '("Last time: …, 4 of 7 right") and the thinking errors noted then. If this is my first session, skip this step.',
    "3. Today's theme: the one focus from the report, with my own numbers (my %, players at my rating %, and the number of games).",
    '4. A guided position, where I try first:',
    '   - Call coach_ask_position without a gameId. It picks a position from my games with the focus pattern, checks it ' +
      'with a deeper search, and shows it as a question: no arrows, no hint.',
    '   - Ask: "What would you play here, and what were you worried about?" Then wait. I either move on the board ' +
      '(it puts "I played … here, because" in the chat for me to finish) or type my move and my reason.',
    '   - Once you have my move and my reason, call coach_check_move with that gameId and ply and my move. ' +
      'The board then shows my move against the best move.',
    '   - Say in one line whether I was right, using the win chances the tool gives. Then name the thinking error behind ' +
      'my reason, not just the move (for example "you didn\'t ask what their last move threatened"), and save it with ' +
      "coach_note_thinking. Then show the refutation, from the tool's lines.",
    '5. Practice: three to five more positions of the same pattern, each with coach_ask_position (no gameId) and the same ' +
      'try-first loop. After a few, point out what the positions have in common. If coach_ask_position says there are ' +
      'no more positions, or that it is enough for today, stop there and tell me honestly how many we did; a short ' +
      "session is fine. Don't make positions up.",
    '6. One rule of thumb for my live games, in one sentence, drawn from the thinking errors you saw. Save it with ' +
      'coach_note_thinking (rule).',
    `7. Homework: about 30 more games in the same time class before the next session, and practice of this focus on my ` +
      `phone in Postgame (${POSTGAME_URL}). If you have a tool that sends drills to Postgame, use it; otherwise don't promise drills.`,
    '8. Close by saying what the next session does: it starts from my student file ("last time: …, 4 of 7 right"), ' +
      'and once I have played about 30 new games, it re-checks this focus on them with a fresh coach_diagnosis.',
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

/**
 * What the board shows instead of a report while games are still being analysed. The board
 * widget gets its own `status` view; this is the same shape.
 */
export interface StatusView {
  kind: 'status';
  title: string;
  message: string;
  progress: { done: number; total: number };
}

/** What the server remembers about one player's lesson. */
interface Lesson {
  /** Lowercased primary username: names the student file. */
  player: string;
  /** Every account of this player, lowercased (the primary one too). */
  accounts: Set<string>;
  d: Diagnosis;
  games: CachedGame[];
  focus: string | null;
  /** The student session (`OpenSession.tag`) that `asked` and `picked` belong to. */
  askedTag: number;
  /** Positions asked in this student session, as refKeys. Starts empty in each new session. */
  asked: Set<string>;
  /** Practice positions picked in this student session (the guided one and the practice ones). */
  picked: number;
  /** Positions the deep check cleared: never worth asking, whatever the session. */
  cleared: Set<string>;
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
  | { ready: true; d: Diagnosis; view: DiagnosisView; games: CachedGame[]; qs: Query[]; skipped: number; player: string };

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
  const now = deps.now ?? Date.now;
  const memo = new Map<string, { d: Diagnosis; view: DiagnosisView }>();
  /** Every deep search of this session, so a position always gets the same answer. */
  const searches: SearchMemo = new Map();
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
   * The diagnosis for a set of queries, shared by coach_diagnosis and coach_report: progress
   * while games are fetched or analysed, a plain failure, or the diagnosis (which also becomes
   * the player's lesson for the coaching tools).
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

    // Reading the cache is fast; the diagnosis itself is not (about 1.7 s for 900 games), so the
    // result is kept per query set and exact set of cached games, and recomputed when either changes.
    const games = uniqueGames(await Promise.all(qs.map((q) => deps.runner.load(q))));
    const memoKey = createHash('sha256')
      .update(JSON.stringify([qs.map(keyOf), games.map((c) => c.game.id).sort()]))
      .digest('hex');
    let found = memo.get(memoKey);
    if (!found) {
      const usernames = qs.flatMap((q) => q.usernames);
      const d = diagnoseFn(games, usernames);
      const examples = examplePositions(d, games, EXAMPLES).map(toRef);
      const byAccount =
        qs.length > 1
          ? qs.map((q) => {
              const names = new Set(q.usernames.map((u) => u.toLowerCase()));
              const n = games.filter((c) => names.has(c.game.username.toLowerCase()) && gamePlies(c) !== null).length;
              return { username: q.usernames.join(', '), games: n };
            })
          : [];
      found = { d, view: diagnosisView(d, examples, repeatedRefs(d, games), byAccount) };
      memo.set(memoKey, found);
      if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value as string);
    }

    const player = qs[0].usernames[0].toLowerCase();
    const prev = lessons.get(player);
    lessons.set(player, {
      player,
      accounts: new Set(qs.flatMap((q) => q.usernames.map((u) => u.toLowerCase()))),
      d: found.d,
      games,
      focus: focusLabel(found.d),
      askedTag: prev?.askedTag ?? 0,
      asked: prev?.asked ?? new Set(),
      picked: prev?.picked ?? 0,
      cleared: prev?.cleared ?? new Set(),
    });
    currentPlayer = player;
    return { ready: true, d: found.d, view: found.view, games, qs, skipped, player };
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
      return { error: failure(`Game ${gameId} is not analysed yet, so there is nothing to show. Run coach_diagnosis first and use one of its gameIds.`) };
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
        gameId: z.string().min(1).describe('Game id from coach_diagnosis (the Chess.com game URL)'),
        ply: z.number().int().min(0).describe("0-based ply from coach_diagnosis (0 is White's first move); must be the player's own move"),
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
      title: 'Diagnose weak spots',
      description:
        "Compares the player's serious-mistake rate (mistakes + blunders) in six areas with players at their rating " +
        '(their opponents in the same games), from analysed games, and picks one focus. While games are still being ' +
        'fetched or analysed it answers within 2 seconds with how far it got; call it again later. The table says ' +
        "'not enough data' where that is true: say so plainly. Positions are given by gameId and ply only, and " +
        'repeated positions carry approximate losses from a quick check: show a position with coach_explain_position ' +
        'before naming any best move or exact number for it. ' +
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
      // A coaching session is running from here on: nothing in it may answer a practice position.
      const view = practiceView(o.view);
      let text = diagnosisText(view, { practice: true });
      if (o.skipped) text += `\n\n${plural(o.skipped, 'game')} could not be read and ${o.skipped === 1 ? 'was' : 'were'} left out.`;
      return reply(text, { ...view });
    },
  );

  registerAppTool(
    server,
    'coach_report',
    {
      title: 'Show the report card',
      description:
        "Shows the player's report card on the board: up to six areas in plain words, their serious-mistake rate against " +
        "players at their rating, the game count, the focus and up to three positions to train this week. Call it once " +
        'coach_diagnosis is done, with the same arguments; while games are still being analysed the board says so. ' +
        'Checking the positions takes a few seconds. Also returns the table as text (show that only if the board did ' +
        "not appear). The positions are today's practice: coach_ask_position asks them; never name their moves first. " +
        NO_INVENTED_FACTS,
      inputSchema: {
        usernames: usernamesSchema,
        accounts: accountsSchema,
        timeClass: timeClassSchema,
        maxGames: maxGamesSchema,
        asOf: asOfSchema,
        headline: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .optional()
          .describe('One or two sentences for the top of the card, from the diagnosis only. Leave out for a plain one.'),
      },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ headline, ...args }) => {
      const o = await diagnosisFor(args);
      if (!o.ready) {
        if (!o.waiting) return o.result;
        const message =
          o.total > 0
            ? `Analysed ${o.done} of ${o.total} games. Ask for the report again in a minute.`
            : 'Getting your games from Chess.com. Ask for the report again in a minute.';
        const status: StatusView = {
          kind: 'status',
          title: 'Still analysing your games',
          message,
          progress: { done: o.done, total: o.total },
        };
        return reply(message, { ...status });
      }

      let positions: ReportPosition[] | undefined;
      let positionsNote: string | null = null;
      try {
        positions = await buildReportPositions(o.d, o.games, deepEngine(), studentOrNothing(o.player));
      } catch (e) {
        positionsNote = `The positions to train could not be checked just now (${msg(e)}), so the card shows none.`;
      }
      const words = reportWords(o.d, positions?.length ?? 0);
      const head = headline ?? words.headline;
      const view = toReportView(o.d, head, { subhead: words.subhead, positions, cta: DEFAULT_REPORT_CTA });

      const lines = [`Report card: ${head} ${words.subhead}`, '', diagnosisText(practiceView(o.view), { practice: true }), ''];
      if (positions && positions.length > 0) {
        const openings = [...new Set(positions.map((p) => p.opening).filter((x): x is string => x !== null))];
        lines.push(
          `The card shows ${plural(positions.length, 'position')} to train this week` +
            `${openings.length ? ` (${openings.join('; ')})` : ''}. They are today's practice positions: don't name or ` +
            'show any move in them; coach_ask_position asks them.',
        );
      }
      if (positionsNote) lines.push(positionsNote);
      lines.push(
        o.d.focus === null
          ? 'No focus yet, so there is nothing to practise: say so plainly.'
          : `Next: practice for the focus (${focusLabel(o.d)}) with coach_ask_position without a gameId; ` +
              'each position is checked with a deeper search before it is asked.',
      );
      if (o.skipped) lines.push(`${plural(o.skipped, 'game')} could not be read and ${o.skipped === 1 ? 'was' : 'were'} left out.`);
      return reply(lines.join('\n'), { ...view });
    },
  );

  registerAppTool(
    server,
    'coach_ask_position',
    {
      title: 'Ask the player a position',
      description:
        "Shows a position from the player's games as a question: the board before their move, with no arrows, no " +
        'evaluation and no hint (try first). Without gameId and ply it picks the next practice position for the focus of ' +
        'the last coach_report or coach_diagnosis, skipping ones already asked this session, up to about six a session; ' +
        'with them it asks that position (the warm-up from coach_student). Each position is checked with a deeper search ' +
        'first and only asked if the game move really went wrong there, so this takes a few seconds. When it says there ' +
        "are no more, practice is over for today: say so honestly. Never name or hint at a move or evaluation until " +
        "coach_check_move has scored the player's try.",
      inputSchema: {
        gameId: z.string().min(1).optional().describe('Game id of a position to ask (with ply); leave out for the next practice position'),
        ply: z.number().int().min(0).optional().describe("0-based ply of the player's own move (with gameId)"),
        prompt: z.string().trim().min(1).max(200).optional().describe(`The question above the board. Default: "${DEFAULT_QUESTION}"`),
        username: optionalUsername,
      },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ gameId, ply, prompt, username }) => {
      const question = prompt ?? DEFAULT_QUESTION;
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
      const ask = (facts: PositionFacts) => {
        lesson?.asked.add(refKey(facts.gameId, facts.ply));
        return reply(questionText(facts, question), { ...toQuestionView(facts, question) });
      };

      if (gameId !== undefined && ply !== undefined) {
        const own = ownPosition(gameId, ply);
        if ('error' in own) return own.error;
        // A repeated position is judged by the repeated-position line, anything else as a single mistake.
        const fen = gamePlies(own.c)?.[ply]?.fenBefore;
        const kind: PracticeKind = lesson && fen && lesson.d.repeated.some((r) => r.key === positionKey(fen)) ? 'repeated' : 'mistake';
        let facts: PositionFacts;
        try {
          facts = await deepPositionFacts(own.c, ply, deepEngine());
        } catch (e) {
          return failure(`Could not check this position: ${msg(e)}`);
        }
        if (!isTeachable(kind, own.c.analysis.plies[ply].classification, facts)) {
          lesson?.cleared.add(refKey(gameId, ply));
          return failure(
            "On a deeper check, the move played in the game here didn't really go wrong, so this position isn't worth " +
              'practising. Call coach_ask_position without gameId and ply for the next practice position.',
          );
        }
        return ask(facts);
      }

      if (!lesson) {
        return failure('No lesson yet: call coach_report (or coach_diagnosis) for this player first, then ask again.');
      }
      if (lesson.picked >= SESSION_POSITIONS) {
        return failure(
          `That's enough practice for one session (${plural(lesson.picked, 'position')}). Move on to the rule of thumb.`,
        );
      }
      const byId = new Map(lesson.games.map((c) => [c.game.id, c]));
      const exclude = new Set([...lesson.asked, ...lesson.cleared]);
      const student = studentOrNothing(lesson.player);
      if (student) for (const k of practiceExclusions(student, openIndex(lesson.player, student), byId)) exclude.add(k);
      const cands = samePatternPositions(lesson.d, lesson.games, [...exclude], ASK_CANDIDATES);
      const noMore =
        `No more practice positions for this focus in these games (${plural(lesson.picked, 'position')} this session). ` +
        'Say so honestly and move on to the rule of thumb.';
      if (cands.length === 0) {
        return failure(lesson.d.focus === null ? 'There is no focus yet, so there is nothing to practise.' : noMore);
      }
      let r: Awaited<ReturnType<typeof firstTeachable>>;
      try {
        const engine = deepEngine();
        r = await firstTeachable(cands, (id) => byId.get(id) ?? readCached(id), (c, p) => deepPositionFacts(c, p, engine), ASK_MAX_CHECKS);
      } catch (e) {
        return failure(`Could not check the next position: ${msg(e)}`);
      }
      for (const x of r.skipped) lesson.cleared.add(refKey(x.gameId, x.ply));
      if (!r.found) {
        return failure(
          cands.length > r.skipped.length
            ? `The deeper check cleared the ${plural(r.skipped.length, 'position')} it looked at (the game move held up). ` +
                'Call coach_ask_position again to check the next ones.'
            : noMore,
        );
      }
      lesson.picked++;
      return ask(r.found.facts);
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
      const keyOf = boardKeyFinder(new Map((lesson?.games ?? []).map((c) => [c.game.id, c])));
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
            lossPts: Math.round(r.lossPts * 10) / 10,
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
      return reply(checkText(r, tally), {
        ...toAnswerView(r.facts, r.attempt),
        correct: r.correct,
        lossPts: Math.round(r.lossPts * 10) / 10,
        attemptWin: Math.round(r.attemptWin * 10) / 10,
        bestWin: Math.round(r.bestWin * 10) / 10,
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
        `| Board engine (deep check) | ${run(display.running)}; ${display.movetimeMs} ms per position, MultiPV ${display.multiPv}; ` +
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
