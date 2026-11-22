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
import { ENGINE_CFG, DISPLAY_CFG, SOURCE_CFG, STATS_CFG } from '../config';
import { AREA_NAMES, gamePlies } from '../diagnosis/areas';
import { diagnose, type AreaFinding, type Diagnosis } from '../diagnosis/diagnose';
import type { RepeatedPosition } from '../diagnosis/repeated';
import { guardDisplayEngine, type DisplayEngine } from '../engine/displayEngine';
import { BOARD_URI } from './boardResource';
import { toAnswerView } from './views';

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
}

const EXAMPLES = 3;
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
 */
export function diagnosisText(v: DiagnosisView): string {
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
      'Positions you keep getting wrong (your moves from the games; losses are approximate, from the quick check; ' +
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
          `${usual ? ` Your moves there: ${usual}.` : ''}` +
          `${r.example ? ` To show it: gameId ${r.example.gameId}, ply ${r.example.ply}.` : ''}`,
      );
    });
    const more = v.repeated.length - MAX_REPEATED_LINES;
    if (more > 0) lines.push(`…and ${plural(more, 'more position')} like these, in the structured data.`);
  }

  if (v.examples.length > 0) {
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

const COACH_ME_RULES = [
  'Never state a move or evaluation that a tool did not return.',
  'Always say how many games a finding rests on.',
  "Say 'not enough data' plainly when a tool says so; never guess past it.",
  'One focus at a time.',
  'No help during a live game: if the user is playing right now, stop and offer to look after the game.',
];

/** Placeholder session text (the full session flow is written in a later task). */
export function coachMeText(username: string): string {
  return [
    `Coach me on my Chess.com games. My username is ${username}.`,
    '',
    'How to run this session:',
    `1. Call coach_diagnosis with usernames ["${username}"] (blitz, ${SOURCE_CFG.defaultMaxGames} games). If it says games are still being analysed, tell me how far it got and check again shortly.`,
    '2. Show me the table in plain words, then the focus.',
    '3. Show one example position for the focus with coach_explain_position, and explain it only from what that tool returns.',
    '',
    'Rules:',
    ...COACH_ME_RULES.map((r) => `- ${r}`),
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

export function registerCoachTools(server: McpServer, deps: CoachDeps): void {
  const listWaitMs = deps.listWaitMs ?? 1500;
  const startWaitMs = deps.startWaitMs ?? 20_000;
  const searchTimeoutMs = deps.searchTimeoutMs ?? 30_000;
  const diagnoseFn = deps.diagnose ?? diagnose;
  const memo = new Map<string, { view: DiagnosisView; text: string }>();

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

  registerAppTool(
    server,
    'coach_explain_position',
    {
      title: 'Show a position on the board',
      description:
        "Shows one of the player's own moves from an analysed game on a chess board: the move played (red arrow), " +
        "Stockfish's best move (green arrow) and best line, the opponent's strongest reply, and the win chance before " +
        'and after. Stockfish first re-checks the position with a deeper search, so this takes a few seconds. ' +
        'Use a gameId and ply from coach_diagnosis. Call this before naming the best move in any position. ' +
        NO_INVENTED_FACTS,
      inputSchema: {
        gameId: z.string().min(1).describe('Game id from coach_diagnosis (the Chess.com game URL)'),
        ply: z.number().int().min(0).describe("0-based ply from coach_diagnosis (0 is White's first move); must be the player's own move"),
      },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ gameId, ply }) => {
      const c = readCached(gameId);
      if (!c) {
        return failure(`Game ${gameId} is not analysed yet, so there is nothing to show. Run coach_diagnosis first and use one of its gameIds.`);
      }
      const plies = c.analysis.plies;
      const p = plies[ply];
      if (!p) return failure(`Game ${gameId} has plies 0 to ${plies.length - 1}; ply ${ply} is not one of them.`);
      if (p.color !== c.game.myColor) {
        const own = [ply - 1, ply + 1].filter((x) => x >= 0 && x < plies.length);
        return failure(
          `Ply ${ply} (${moveLabel(Math.floor(ply / 2) + 1, p.color, p.moveSan)}) is your opponent's move, not yours. ` +
            `The board shows your own moves only (you were ${capitalize(c.game.myColor)} in this game)` +
            `${own.length ? `: try ply ${own.join(' or ')}` : ''}.`,
        );
      }
      let facts: PositionFacts;
      try {
        const engine = deps.display.get();
        facts = await deepPositionFacts(
          c,
          ply,
          guardDisplayEngine(engine, searchTimeoutMs, () => deps.display.reset(engine)),
        );
      } catch (e) {
        return failure(`Could not check this position: ${msg(e)}`);
      }
      const disagrees = deepDisagrees(p.classification, facts.classification);
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
      const accounts = r.value.map((s, i) => ({ usernames: qs[i].usernames, jobId: s.jobId, total: s.total, cached: s.cached }));
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
      const qs = toQueries(args);
      if (typeof qs === 'string') return failure(qs);
      const ts = qs.map((q) => track(q, false));
      const broken = ts.find((t) => t.error !== undefined);
      if (broken) {
        forget(ts);
        return failure(`Could not get the game list from Chess.com: ${broken.error}. Call again to retry.`);
      }
      let r: { value: Started[] } | null;
      try {
        r = await within(Promise.all(ts.map((t) => t.started)), listWaitMs);
      } catch (e) {
        forget(ts);
        return failure(`Could not get the game list from Chess.com: ${msg(e)}. Call again to retry.`);
      }
      if (!r) return reply('Getting the game lists from Chess.com. Ask again in a moment.', { state: 'fetching' });

      const jobIds = r.value.map((s) => s.jobId);
      const statuses: JobStatus[] = jobIds.map((id) => deps.runner.status(id));
      const failed = statuses.find((st) => st.state === 'error');
      if (failed) {
        forget(ts);
        return failure(`The analysis stopped: ${failed.error}. Call coach_start_analysis to try again.`);
      }
      const sum = (f: (st: JobStatus) => number) => statuses.reduce((n, st) => n + f(st), 0);
      const skipped = sum((st) => st.skipped ?? 0);
      if (statuses.some((st) => st.state === 'running')) {
        const done = sum((st) => st.done);
        const total = sum((st) => st.total);
        return reply(progressText(done, total, skipped), { state: 'running', jobIds, done, total, skipped });
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
        const view = diagnosisView(d, examples, repeatedRefs(d, games), byAccount);
        found = { view, text: diagnosisText(view) };
        memo.set(memoKey, found);
        if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value as string);
      }
      let text = found.text;
      if (skipped) text += `\n\n${plural(skipped, 'game')} could not be read and ${skipped === 1 ? 'was' : 'were'} left out.`;
      return reply(text, { ...found.view });
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
      description: "Start a coaching session on a Chess.com player's recent games",
      argsSchema: { username: z.string().min(1).describe('Chess.com username') },
    },
    ({ username }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: coachMeText(username) } }],
    }),
  );
}
