/**
 * The coach's MCP tools and the `coach_me` prompt. Every tool answers with a plain-text
 * version (for any host, and for the model) plus `structuredContent`. Tools linked to the
 * board widget (BOARD_URI) return a `CoachView` as `structuredContent`.
 *
 * Every move and number shown comes from a tool: the stats (diagnosis), the game record, or
 * a deep engine search (DISPLAY_CFG) made just before a position is shown. Quick-search
 * (ENGINE_CFG) best moves and win % are never printed in the text. (The Diagnosis passed as
 * structuredContent still carries each repeated position's quick-search `best`; the tool
 * descriptions send the model to coach_explain_position before it names a best move.)
 *
 * Dependencies are passed in, so tests run with fake engines and sources and never touch
 * Stockfish, the network or the real coach home.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { formatLineSan } from '../../../src/analysis/lines';
import type { Engine, Evaluation } from '../../../src/services/engine/types';
import type { TimeClass } from '../../../src/types';
import { readCached } from '../analysis/cache';
import type { JobStatus, Query, Runner } from '../analysis/runner';
import { deepPositionFacts, examplePositions, type PositionFacts } from '../coaching/explain';
import { DISPLAY_CFG, ENGINE_CFG, SOURCE_CFG, STATS_CFG } from '../config';
import { AREA_NAMES } from '../diagnosis/areas';
import { diagnose, type AreaFinding, type Diagnosis } from '../diagnosis/diagnose';
import { BOARD_URI } from './boardResource';
import { toAnswerView } from './views';

/** The deep-search engine (built with DISPLAY_CFG): one instance, created on first use. */
export interface DisplayEngine {
  get(): Engine;
  /**
   * Forgets (and closes) `failed` after a failure, so the next `get` builds a fresh one. Does
   * nothing if a newer engine has replaced it meanwhile.
   */
  reset(failed: Engine): void;
}

export interface EngineInfo {
  stockfishPath: string;
  binaryFound: boolean;
  analysis: { running: boolean; positionsSearched: number };
  display: { running: boolean; positionsSearched: number };
}

export interface CoachDeps {
  runner: Runner;
  display: DisplayEngine;
  engineInfo(): EngineInfo;
  /** Free memory %, checked before a batch of more than 50 games; null when it can't be read. Unchecked when absent. */
  freeMemoryPct?: () => number | null;
  /** How long coach_diagnosis waits for the game list before answering with progress. Default 1500 ms. */
  listWaitMs?: number;
  /** How long coach_start_analysis waits for the game list. Default 20 s. */
  startWaitMs?: number;
  /** Max time for one deep search before the display engine counts as hung. Default 30 s. */
  searchTimeoutMs?: number;
}

/** A batch above this many games needs a memory check first (Mac limits). */
const BIG_BATCH = 50;
const MIN_FREE_MEMORY_PCT = 20;
const EXAMPLES = 3;

const NO_INVENTED_FACTS =
  'Never state a move or evaluation that a tool did not return; always say how many games a finding rests on.';

// ---- input schemas ----

const TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'daily'] as const;
const usernamesSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .describe("The player's Chess.com usernames (one person; several accounts are pooled)");
const timeClassSchema = z.enum(TIME_CLASSES).default('blitz').describe('Time class of the games to use');
const maxGamesSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(SOURCE_CFG.defaultMaxGames)
  .describe('How many recent rated games to use');
const asOfSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-01')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'not a real date')
  .optional()
  .describe('Only use games that ended before this date (YYYY-MM-DD, UTC). Leave out for the latest games.');

interface QueryArgs {
  usernames: string[];
  timeClass: TimeClass;
  maxGames: number;
  asOf?: string;
}

function toQuery(a: QueryArgs): Query {
  const q: Query = { usernames: a.usernames, timeClass: a.timeClass, maxGames: a.maxGames };
  if (a.asOf) q.before = Math.floor(Date.parse(`${a.asOf}T00:00:00Z`) / 1000);
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

/** Wraps the display engine: each search has a time limit, and any failure drops the engine. */
function guardedEngine(display: DisplayEngine, timeoutMs: number): Engine {
  const engine = display.get();
  return {
    async evaluate(fen: string, ms: number): Promise<Evaluation> {
      try {
        const r = await within(Promise.resolve(engine.evaluate(fen, ms)), timeoutMs);
        if (!r) throw new Error(`Stockfish did not answer within ${Math.round(timeoutMs / 1000)} s`);
        return r.value;
      } catch (e) {
        display.reset(engine);
        throw e;
      }
    },
  };
}

// ---- text versions ----

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

const moveLabel = (moveNumber: number, mover: 'white' | 'black', san: string) =>
  `${moveNumber}${mover === 'white' ? '.' : '...'} ${san}`;

/**
 * The diagnosis as text: a table (area, verdict in plain words, the player's %, players at
 * their rating %, game count), the focus, the notes, the repeated positions and example
 * positions by reference. Rows without enough data show no percentages.
 */
export function diagnosisText(d: Diagnosis, examples: ExampleRef[]): string {
  const who = d.usernames.join(', ');
  const lines: string[] = [];
  lines.push(
    `Diagnosis for ${who}: ${plural(d.games, `${d.timeClass} game`)}. Each row compares the share of your moves ` +
      'that were serious mistakes (a mistake or a blunder) with the same share for players at your rating, ' +
      'your opponents in the same games.',
  );
  lines.push('');
  lines.push('| Area | Verdict | You % | Players at your rating % | Games |');
  lines.push('|---|---|---|---|---|');
  for (const a of d.areas) {
    const known = a.label !== 'notEnoughData';
    lines.push(
      `| ${capitalize(AREA_NAMES[a.area])} | ${verdict(a)} | ${known ? pct1(a.myRate) : '–'} | ` +
        `${known ? pct1(a.oppRate) : '–'} | ${a.games} |`,
    );
  }
  lines.push('');

  const focus = d.focus;
  if (focus?.kind === 'area') {
    const a = d.areas.find((x) => x.area === focus.area);
    lines.push(`Focus: ${AREA_NAMES[focus.area]}${a ? ` (${verdict(a)}, ${plural(a.games, 'game')})` : ''}.`);
  } else if (focus?.kind === 'repeated') {
    lines.push(`Focus: the ${focus.keys.length === 1 ? 'position' : `${focus.keys.length} positions`} you keep getting wrong (below).`);
  } else {
    lines.push('Focus: none yet.');
  }

  if (d.notes.length > 0) {
    lines.push('', 'Notes:');
    for (const n of d.notes) lines.push(`- ${n}`);
  }

  if (d.repeated.length > 0) {
    lines.push('', 'Positions you keep getting wrong (your moves from the games; the best move is not shown until the position is checked deeply):');
    d.repeated.forEach((r, i) => {
      const usual = r.usual.map((u) => `${u.move} ${plural(u.times, 'time')}`).join(', ');
      const where = r.movesFromStart.length > 0 ? `After ${formatLineSan(r.movesFromStart, 0)}` : 'In the starting position';
      lines.push(
        `${i + 1}. ${where}: you had to move here in ` +
          `${plural(r.seen, 'game')} and went wrong ${plural(r.wrong, 'time')}${usual ? ` (you played ${usual})` : ''}.`,
      );
    });
  }

  if (examples.length > 0) {
    lines.push('', 'Example positions for the focus (show one with coach_explain_position, using its gameId and ply):');
    for (const x of examples) {
      lines.push(
        `- gameId ${x.gameId}, ply ${x.ply}: you played ${moveLabel(x.moveNumber, x.mover, x.playedSan)} as ` +
          `${capitalize(x.mover)}. Game: ${x.gameUrl}`,
      );
    }
  }
  return lines.join('\n');
}

function progressText(st: JobStatus): string {
  const skipped = st.skipped ? ` ${plural(st.skipped, 'game')} could not be read and will be left out.` : '';
  return (
    `Still working: analysed ${st.done} of ${plural(st.total, 'game')} so far.${skipped} ` +
    'The diagnosis needs every game, so ask again in a minute or two.'
  );
}

/** The deep facts as text, for the model and for hosts without the board. */
function explainText(f: PositionFacts): string {
  const side = capitalize(f.mover);
  const moveNumber = Math.floor(f.ply / 2) + 1;
  const lines = [
    `Game ${f.gameUrl}, move ${moveLabel(moveNumber, f.mover, f.playedSan)} (ply ${f.ply}, ${side} to move).`,
    `Position before the move (FEN): ${f.fenBefore}`,
    `${side} played ${f.playedSan} (${f.playedUci}).`,
    f.bestSan
      ? `Stockfish's best move: ${f.bestSan} (${f.bestUci}).`
      : `${f.playedSan} was Stockfish's first choice.`,
  ];
  if (f.bestLineSan?.length) lines.push(`Best line: ${formatLineSan(f.bestLineSan, f.ply)}.`);
  lines.push(`${side}'s win chance: ${Math.round(f.winBefore)}% before the move, ${Math.round(f.winAfter)}% after.`);
  if (f.refutationSan?.length) lines.push(`The opponent's strongest reply after ${f.playedSan}: ${formatLineSan(f.refutationSan, f.ply + 1)}.`);
  if (f.reason) lines.push(`Why: ${f.reason}`);
  lines.push(
    `Engine check: Stockfish, ${DISPLAY_CFG.movetimeMs / 1000} s on each position (before and after the move), ` +
      'just now; these are the only moves and numbers to quote for this position.',
  );
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

// ---- registration ----

export function registerCoachTools(server: McpServer, deps: CoachDeps): void {
  const listWaitMs = deps.listWaitMs ?? 1500;
  const startWaitMs = deps.startWaitMs ?? 20_000;
  const searchTimeoutMs = deps.searchTimeoutMs ?? 30_000;

  /** Starts by query, from this server session: the diagnosis reuses them instead of re-walking the archives. */
  interface Tracked {
    q: Query;
    started: Promise<Started>;
    result?: Started;
    error?: string;
  }
  const tracked = new Map<string, Tracked>();
  const keyOf = (q: Query) => JSON.stringify([[...q.usernames].sort(), q.timeClass, q.maxGames, q.before ?? null]);

  /** A memory problem that should stop a new batch, or null. */
  function memoryRefusal(q: Query): string | null {
    if (!deps.freeMemoryPct || q.maxGames <= BIG_BATCH) return null;
    const free = deps.freeMemoryPct();
    if (free === null) return 'Could not read free memory (memory_pressure), so the analysis was not started.';
    if (free < MIN_FREE_MEMORY_PCT) {
      return `Only ${free}% of memory is free (${MIN_FREE_MEMORY_PCT}% needed to analyse more than ${BIG_BATCH} games). Close some apps and try again.`;
    }
    return null;
  }

  /** The tracked start for a query; a new one when none exists or `fresh` is set. A string is a refusal. */
  function track(q: Query, fresh: boolean): Tracked | string {
    const key = keyOf(q);
    const existing = tracked.get(key);
    if (existing && !fresh) return existing;
    const refusal = memoryRefusal(q);
    if (refusal) return refusal;
    const t: Tracked = { q, started: deps.runner.start(q) };
    t.started.then(
      (r) => (t.result = r),
      (e) => (t.error = msg(e)),
    );
    tracked.set(key, t);
    return t;
  }

  registerAppTool(
    server,
    'coach_explain_position',
    {
      title: 'Show a position on the board',
      description:
        'Shows one move from an analysed game on a chess board: the move played (red arrow), Stockfish\'s best move ' +
        '(green arrow) and best line, the opponent\'s strongest reply, and the win chance before and after. ' +
        `Stockfish re-checks the position deeply (${DISPLAY_CFG.movetimeMs / 1000} s per position) first, so this takes a few seconds. ` +
        'Use a gameId and ply from coach_diagnosis. Call this before naming the best move in any position. ' +
        NO_INVENTED_FACTS,
      inputSchema: {
        gameId: z.string().min(1).describe('Game id from coach_diagnosis (the Chess.com game URL)'),
        ply: z.number().int().min(0).describe('0-based ply from coach_diagnosis (0 is White\'s first move)'),
      },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ gameId, ply }) => {
      const c = readCached(gameId);
      if (!c) {
        return failure(`Game ${gameId} is not analysed yet, so there is nothing to show. Run coach_diagnosis first and use one of its gameIds.`);
      }
      let facts: PositionFacts;
      try {
        facts = await deepPositionFacts(c, ply, guardedEngine(deps.display, searchTimeoutMs));
      } catch (e) {
        return failure(`Could not check this position: ${msg(e)}`);
      }
      return reply(explainText(facts), { ...toAnswerView(facts) });
    },
  );

  server.registerTool(
    'coach_start_analysis',
    {
      title: 'Start analysing games',
      description:
        "Fetches the player's recent rated Chess.com games and starts analysing the ones not analysed yet, in the background " +
        `(Stockfish, ${ENGINE_CFG.movetimeMs} ms per position). Returns at once with how many games there are. ` +
        'Also refreshes the game list. Then call coach_diagnosis.',
      inputSchema: { usernames: usernamesSchema, timeClass: timeClassSchema, maxGames: maxGamesSchema },
    },
    async (args) => {
      const q = toQuery(args);
      const t = track(q, true);
      if (typeof t === 'string') return failure(t);
      let r: { value: Started } | null;
      try {
        r = await within(t.started, startWaitMs);
      } catch (e) {
        tracked.delete(keyOf(q));
        return failure(`Could not get the game list from Chess.com: ${msg(e)}`);
      }
      if (!r) {
        return reply('Still getting the game list from Chess.com; the analysis starts on its own after that. Call coach_diagnosis in a minute.', {
          state: 'fetching',
        });
      }
      const { jobId, total, cached } = r.value;
      const st = deps.runner.status(jobId);
      const games = plural(total, `${q.timeClass} game`);
      const text =
        total === 0
          ? `No rated ${q.timeClass} games found for ${q.usernames.join(', ')}.`
          : cached === total
            ? `Found ${games} for ${q.usernames.join(', ')}; all are analysed already. Call coach_diagnosis.`
            : `Found ${games} for ${q.usernames.join(', ')}: ${cached} analysed already, analysing the other ${total - cached} ` +
              'in the background. Call coach_diagnosis to see progress or the result.';
      return reply(text, { jobId, total, cached, done: st.done, state: st.state });
    },
  );

  server.registerTool(
    'coach_diagnosis',
    {
      title: 'Diagnose weak spots',
      description:
        "Compares the player's serious-mistake rate (mistakes + blunders) in six areas with players at their rating " +
        '(their opponents in the same games), from analysed games, and picks one focus. Answers within 2 seconds: ' +
        'while games are still being analysed it says how many are done; call it again later. The table says ' +
        "'not enough data' where that is true: say so plainly. Example positions are given by gameId and ply only: " +
        'show them with coach_explain_position before naming any best move. ' +
        NO_INVENTED_FACTS,
      inputSchema: { usernames: usernamesSchema, timeClass: timeClassSchema, maxGames: maxGamesSchema, asOf: asOfSchema },
    },
    async (args) => {
      const q = toQuery(args);
      const t = track(q, false);
      if (typeof t === 'string') return failure(t);
      if (t.error) {
        tracked.delete(keyOf(q));
        return failure(`Could not get the game list from Chess.com: ${t.error}. Call again to retry.`);
      }
      let r: { value: Started } | null;
      try {
        r = await within(t.started, listWaitMs);
      } catch (e) {
        tracked.delete(keyOf(q));
        return failure(`Could not get the game list from Chess.com: ${msg(e)}. Call again to retry.`);
      }
      if (!r) {
        return reply('Fetching the game list from Chess.com; nothing is analysed yet. Ask again in a moment.', { state: 'fetching' });
      }
      const { jobId } = r.value;
      const st = deps.runner.status(jobId);
      if (st.state === 'running') {
        return reply(progressText(st), { state: 'running', jobId, done: st.done, total: st.total, skipped: st.skipped ?? 0 });
      }
      if (st.state === 'error') {
        tracked.delete(keyOf(q));
        return failure(`The analysis stopped: ${st.error}. Call coach_start_analysis to try again.`);
      }
      const games = await deps.runner.load(q);
      const d = diagnose(games, q.usernames);
      const examples = examplePositions(d, games, EXAMPLES).map(toRef);
      let text = diagnosisText(d, examples);
      if (st.skipped) text += `\n\n${plural(st.skipped, 'game')} could not be read and ${st.skipped === 1 ? 'was' : 'were'} left out.`;
      return reply(text, { ...d, examples });
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
