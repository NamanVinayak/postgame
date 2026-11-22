import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Chess } from 'chess.js';
import { evalToWinPct } from '../../../src/analysis/winPct';
import type { Engine, Evaluation } from '../../../src/services/engine/types';
import type { Classification, TimeClass } from '../../../src/types';
import { writeCached, type CachedGame } from '../analysis/cache';
import { memoryGuarded } from '../analysis/memoryPressure';
import { createRunner, type EngineFactory, type Runner } from '../analysis/runner';
import { rightSessionsByBoard } from '../coaching/lesson';
import { loadStudent } from '../coaching/student';
import { diagnose, type AreaFinding, type Diagnosis } from '../diagnosis/diagnose';
import { positionKey } from '../diagnosis/repeated';
import { fixtureGame } from '../diagnosis/testGames';
import { createDisplayEngine, type DisplayEngine } from '../engine/displayEngine';
import type { CoachGame, GameSource } from '../sources/types';
import { BOARD_URI } from './boardResource';
import {
  checkText,
  diagnosisText,
  diagnosisView,
  isRealDate,
  registerCoachTools,
  reportWords,
  type CoachDeps,
  type EngineInfo,
} from './tools';

// ---- fixtures (made-up players only) ----

const PGN = '[Event "x"]\n\n1. e4 e5 2. Nf3 Nc6 *';
const EVAL: Evaluation = { cp: 20, mate: null, bestMoveUci: 'e2e4', secondBest: null, pvUci: ['e2e4'] };

function game(n: number): CoachGame {
  return {
    id: `https://example.test/game/live/${n}`,
    url: `https://example.test/game/live/${n}`,
    timeClass: 'blitz',
    endTime: 1_700_000_000 + n,
    rated: true,
    myColor: 'white',
    outcome: 'win',
    opponent: { username: 'bob', rating: 1500 },
    myRating: 1500,
    pgn: PGN,
    username: 'alice',
    timeControl: '180+2',
    baseSec: 180,
    incSec: 2,
    myPreRating: 1490,
    clocks: [],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** An analysis engine that holds every search until `gate` opens: the job stays "running". */
function gatedEngine(gate: Promise<void>): Engine {
  return {
    async evaluate() {
      await gate;
      return EVAL;
    },
  };
}

type FetchCall = { usernames: string[]; maxGames: number; timeClass: TimeClass; before?: number };

/** A source that records each fetch; `byUser` gives each account's games (default: `games` for anyone). */
function source(games: CoachGame[], gate?: Promise<void>, byUser?: Record<string, CoachGame[]>): GameSource & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  return {
    calls,
    async fetchGames(usernames, opts) {
      calls.push({ usernames, ...opts });
      if (gate) await gate;
      if (!byUser) return games;
      return usernames.flatMap((u) => byUser[u] ?? []).slice(-opts.maxGames);
    },
  };
}

const ENGINE_INFO: EngineInfo = {
  stockfishPath: '/fake/stockfish',
  binaryFound: true,
  analysis: { running: false, positionsSearched: 0 },
  display: { running: false, positionsSearched: 0 },
};

function deps(runner: Runner, display: Engine | null = null): CoachDeps & { resets: DisplayEngine[] } {
  const branded = display ? createDisplayEngine(() => display) : null;
  const d = {
    resets: [] as DisplayEngine[],
    runner,
    display: {
      get(): DisplayEngine {
        if (!branded) throw new Error('no display engine in this test');
        return branded;
      },
      reset(failed: DisplayEngine) {
        d.resets.push(failed);
      },
    },
    engineInfo: () => ENGINE_INFO,
  };
  return d;
}

async function connect(d: CoachDeps): Promise<Client> {
  const server = new McpServer({ name: 'coach-test', version: '0.0.0' });
  registerCoachTools(server, d);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'coach-test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

type CallResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const textOf = (r: CallResult) => r.content.map((c) => c.text ?? '').join('\n');
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallResult;
const waitAll = async (runner: Runner, r: CallResult) => {
  for (const id of (r.structuredContent?.jobIds as string[] | undefined) ?? []) await runner.wait(id);
};

const NO_ENGINE: EngineFactory = () => {
  throw new Error('the analysis engine is not used in this test');
};

// Every test runs against its own coach home; jobs are always finished before it is removed.
let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.POSTGAME_COACH_HOME;
  home = mkdtempSync(join(tmpdir(), 'coach-c1-'));
  process.env.POSTGAME_COACH_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.POSTGAME_COACH_HOME;
  else process.env.POSTGAME_COACH_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const ALICE = { usernames: ['alice'], timeClass: 'blitz', maxGames: 300 };

/** A cached, replayable game of `username` (made-up moves), and the source's view of it. */
function cachedGame(id: string, username: string): CachedGame {
  const c = fixtureGame({ id, sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'], username });
  writeCached(c);
  return c;
}

describe('coach_diagnosis', () => {
  it('diagnosisReturnsProgressWhileRunning', async () => {
    const gate = deferred();
    const runner = createRunner(() => gatedEngine(gate.promise), source([game(1), game(2), game(3)]));
    const client = await connect(deps(runner));
    let first: CallResult | undefined;
    try {
      const t0 = Date.now();
      first = await call(client, 'coach_diagnosis', ALICE);
      const ms = Date.now() - t0;
      expect(ms).toBeLessThan(2000);
      expect(first.isError).toBeFalsy();
      const text = textOf(first);
      expect(text).toContain('analysed');
      expect(text).toContain(' of ');
      expect(text).toMatch(/analysed 0 of 3 games so far/);
      expect(first.structuredContent).toMatchObject({ state: 'running', done: 0, total: 3 });
    } finally {
      gate.resolve();
      if (first) await waitAll(runner, first);
      await runner.close();
    }

    // Once the job is done, the same call gives the diagnosis (3 games: nothing can be judged yet).
    const done = await call(client, 'coach_diagnosis', ALICE);
    expect(done.structuredContent).toMatchObject({ games: 3, usernames: ['alice'] });
    expect(textOf(done)).toContain('not enough data');
    expect(textOf(done)).toContain('3 blitz games');
  });

  it('answers within 2 s while the game list is still being fetched, without claiming nothing is analysed', async () => {
    const gate = deferred();
    const runner = createRunner(() => gatedEngine(Promise.resolve()), source([game(1)], gate.promise));
    const client = await connect(deps(runner));
    try {
      const t0 = Date.now();
      const res = await call(client, 'coach_diagnosis', ALICE);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(textOf(res)).toMatch(/getting the game lists/i);
      expect(textOf(res)).not.toMatch(/nothing is analysed/i);
      expect(res.structuredContent).toMatchObject({ state: 'fetching' });
    } finally {
      gate.resolve();
      // The start the first call made carries on; wait for it through the tool itself.
      for (let i = 0; i < 100; i++) {
        const r = await call(client, 'coach_diagnosis', ALICE);
        if (r.structuredContent?.games === 1) break;
        await new Promise((res) => setTimeout(res, 20));
      }
      await runner.close();
    }
  });

  it('several accounts: each with its own game limit, concatenated before the diagnosis', async () => {
    const a = [cachedGame('https://example.test/game/a1', 'alice'), cachedGame('https://example.test/game/a2', 'alice')];
    const b = [cachedGame('https://example.test/game/b1', 'alice2')];
    const src = source([], undefined, { alice: a.map((c) => c.game), alice2: b.map((c) => c.game) });
    const runner = createRunner(NO_ENGINE, src);
    const client = await connect(deps(runner));
    const args = { accounts: [{ username: 'alice', maxGames: 2 }, { username: 'alice2', maxGames: 600 }], timeClass: 'blitz' };
    const res = await call(client, 'coach_diagnosis', args);
    expect(res.isError).toBeFalsy();
    expect(src.calls.map((c) => [c.usernames, c.maxGames])).toEqual([
      [['alice'], 2],
      [['alice2'], 600],
    ]);
    expect(res.structuredContent).toMatchObject({ games: 3, usernames: ['alice', 'alice2'] });
    expect(res.structuredContent?.gamesByAccount).toEqual([
      { username: 'alice', games: 2 },
      { username: 'alice2', games: 1 },
    ]);
    expect(textOf(res)).toContain('Games per account: alice 2, alice2 1.');
    await runner.close();
  });

  it('several accounts still running: progress summed over their jobs, within 2 s', async () => {
    const gate = deferred();
    const other = (n: number): CoachGame => ({ ...game(n), username: 'alice2' });
    const src = source([], undefined, { alice: [game(1), game(2)], alice2: [other(3), other(4), other(5)] });
    const runner = createRunner(() => gatedEngine(gate.promise), src);
    const client = await connect(deps(runner));
    let res: CallResult | undefined;
    try {
      const t0 = Date.now();
      res = await call(client, 'coach_diagnosis', {
        accounts: [{ username: 'alice', maxGames: 2 }, { username: 'alice2', maxGames: 3 }],
        timeClass: 'blitz',
      });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(textOf(res)).toMatch(/analysed 0 of 5 games so far/);
      expect(res.structuredContent).toMatchObject({ state: 'running', done: 0, total: 5 });
      expect(res.structuredContent?.jobIds).toHaveLength(2);
    } finally {
      gate.resolve();
      if (res) await waitAll(runner, res);
      await runner.close();
    }
  });

  it('keeps the diagnosis for repeat calls until the set of cached games changes', async () => {
    const a = cachedGame('https://example.test/game/m1', 'alice');
    const games = [a.game];
    const src: GameSource = { fetchGames: async () => [...games] };
    const runner = createRunner(NO_ENGINE, src);
    let runs = 0;
    const counting: typeof diagnose = (g, u, b) => (runs++, diagnose(g, u, b));
    const client = await connect({ ...deps(runner), diagnose: counting });
    const first = await call(client, 'coach_diagnosis', ALICE);
    const again = await call(client, 'coach_diagnosis', ALICE);
    expect(runs).toBe(1);
    expect(textOf(again)).toBe(textOf(first));
    expect(again.structuredContent).toEqual(first.structuredContent);
    // A new cached game (after a refresh) is a different set: diagnosed again.
    games.push(cachedGame('https://example.test/game/m2', 'alice').game);
    await call(client, 'coach_start_analysis', ALICE);
    const fresh = await call(client, 'coach_diagnosis', ALICE);
    expect(runs).toBe(2);
    expect(fresh.structuredContent).toMatchObject({ games: 2 });
    await runner.close();
  });

  it('never refuses a diagnosis of cached games, even with low memory', async () => {
    const c = cachedGame('https://example.test/game/c1', 'alice');
    const runner = createRunner(memoryGuarded(NO_ENGINE, () => 5), source([c.game]));
    const client = await connect(deps(runner));
    const res = await call(client, 'coach_diagnosis', ALICE);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ games: 1 });
    await runner.close();
  });

  it('refuses to start Stockfish with low memory, as a plain job error', async () => {
    const runner = createRunner(memoryGuarded(() => gatedEngine(Promise.resolve()), () => 12), source([game(1)]));
    const client = await connect(deps(runner));
    const started = await call(client, 'coach_start_analysis', ALICE);
    await waitAll(runner, started);
    const res = await call(client, 'coach_diagnosis', ALICE);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/The analysis stopped: only 12% of memory is free/);
    await runner.close();
  });

  it('rejects an asOf that is not a real date, and passes a real one on as "before"', async () => {
    const src = source([]);
    const runner = createRunner(NO_ENGINE, src);
    const client = await connect(deps(runner));
    for (const bad of ['2026-13-45', '2026-02-30']) {
      const res = await call(client, 'coach_diagnosis', { ...ALICE, asOf: bad });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/not a real date/);
    }
    const ok = await call(client, 'coach_diagnosis', { ...ALICE, asOf: '2026-02-28' });
    expect(ok.isError).toBeFalsy();
    expect(src.calls.at(-1)?.before).toBe(Date.UTC(2026, 1, 28) / 1000);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    await runner.close();
  });

  it('needs usernames or accounts', async () => {
    const client = await connect(deps(createRunner(NO_ENGINE, source([]))));
    const res = await call(client, 'coach_diagnosis', { timeClass: 'blitz' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/usernames/);
  });

  it('reports a failed analysis plainly', async () => {
    const broken: Engine = {
      async evaluate() {
        throw new Error('Stockfish exited unexpectedly');
      },
    };
    const runner = createRunner(() => broken, source([game(1)]));
    const client = await connect(deps(runner));
    const first = await call(client, 'coach_start_analysis', ALICE);
    await waitAll(runner, first);
    const res = await call(client, 'coach_diagnosis', ALICE);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Stockfish exited unexpectedly');
    await runner.close();
  });
});

describe('coach_start_analysis', () => {
  it('starts the job and says how many games are cached and left', async () => {
    const runner = createRunner(() => gatedEngine(Promise.resolve()), source([game(1), game(2)]));
    const client = await connect(deps(runner));
    const res = await call(client, 'coach_start_analysis', { usernames: ['alice'] });
    // Finish the job before any assertion can fail, so nothing writes after the temp home is gone.
    await waitAll(runner, res);
    await runner.close();
    expect(res.structuredContent).toMatchObject({ total: 2, cached: 0 });
    expect(textOf(res)).toContain('2 blitz games');
  });

  it('fetches several accounts one after another, never at the same time', async () => {
    let active = 0;
    let maxActive = 0;
    const slow: GameSource = {
      async fetchGames() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return [];
      },
    };
    const runner = createRunner(NO_ENGINE, slow);
    const client = await connect(deps(runner));
    const res = await call(client, 'coach_start_analysis', {
      accounts: [{ username: 'alice', maxGames: 10 }, { username: 'alice2', maxGames: 20 }],
    });
    expect(res.structuredContent).toMatchObject({ total: 0, state: 'done' });
    expect(maxActive).toBe(1);
    await runner.close();
  });
});

// Made-up game: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.Ng5 d5. Ply 5 is Black's ...Nf6.
const SANS = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5'];
const FEN_BEFORE_5 = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const FEN_AFTER_5 = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const GAME_ID = 'https://example.test/game/live/42';

/** The player (Black) played ...Nf6, cached as a mistake (Black's win % 45 → 34). */
function cachedItalian() {
  const best = SANS.map(() => undefined as string | null | undefined);
  best[5] = 'Be7'; // the quick search's choice; the deep search below prefers Bc5
  const cls = SANS.map(() => undefined as Classification | undefined);
  const c = fixtureGame({ id: GAME_ID, sans: SANS, wins: [52, 50, 54, 52, 55, 66, 60, 70], best, cls, myColor: 'black' });
  c.analysis.plies[5].reason = 'A stronger move was Be7.';
  return c;
}

function deepEngine(before: Evaluation, after: Evaluation): Engine & { searched: string[] } {
  const byFen: Record<string, Evaluation> = { [FEN_BEFORE_5]: before, [FEN_AFTER_5]: after };
  const searched: string[] = [];
  return {
    searched,
    async evaluate(fen) {
      searched.push(fen);
      const e = byFen[fen];
      if (!e) throw new Error(`unexpected search ${fen}`);
      return e;
    },
  };
}
const BC5_BEFORE: Evaluation = { cp: 80, mate: null, bestMoveUci: 'f8c5', secondBest: null, pvUci: ['f8c5', 'c2c3', 'g8f6'] };
const NG5_AFTER: Evaluation = { cp: 150, mate: null, bestMoveUci: 'f3g5', secondBest: null, pvUci: ['f3g5', 'd7d5', 'e4d5'] };

describe('coach_explain_position', () => {
  it('explainToolCarriesBoardMeta', async () => {
    writeCached(cachedItalian());
    const engine = deepEngine(BC5_BEFORE, NG5_AFTER);
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine));

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'coach_explain_position');
    expect((tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(BOARD_URI);

    const res = await call(client, 'coach_explain_position', { gameId: GAME_ID, ply: 5 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.kind).toBe('answer');
    expect(res.structuredContent?.fen).toBe(FEN_BEFORE_5);
    // Everything shown comes from the deep search, never the cached quick one.
    expect(engine.searched).toEqual([FEN_BEFORE_5, FEN_AFTER_5]);
    expect(res.structuredContent).toMatchObject({
      playedUci: 'g8f6',
      bestUci: 'f8c5',
      bestSan: 'Bc5',
      orientation: 'black',
      deepDisagrees: false,
    });
    const text = textOf(res);
    expect(text).toContain('Bc5');
    expect(text).toContain('Ng5');
    expect(text).not.toContain('Be7');
    expect(text).toContain('Checked with a deeper search');
    expect(text).not.toMatch(/1\.5 s/);
    expect(text).not.toMatch(/holds up/);
    expect(JSON.stringify(res.structuredContent)).not.toContain('Be7');
  });

  it('says plainly when the deep check clears a quick-check mistake', async () => {
    writeCached(cachedItalian());
    // The deep search's own first choice is the played ...Nf6, with no loss.
    const engine = deepEngine(
      { cp: 20, mate: null, bestMoveUci: 'g8f6', secondBest: null, pvUci: ['g8f6', 'f3g5'] },
      { cp: -20, mate: null, bestMoveUci: 'f3g5', secondBest: null, pvUci: ['f3g5', 'd7d5'] },
    );
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine));
    const res = await call(client, 'coach_explain_position', { gameId: GAME_ID, ply: 5 });
    expect(res.structuredContent).toMatchObject({ deepDisagrees: true, bestUci: null });
    expect(textOf(res)).toContain("On a deeper check this move holds up, so it isn't a real mistake.");
  });

  it("refuses the opponent's moves: the board speaks to the player", async () => {
    writeCached(cachedItalian()); // the player is Black
    const engine = deepEngine(BC5_BEFORE, NG5_AFTER);
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine));
    const res = await call(client, 'coach_explain_position', { gameId: GAME_ID, ply: 4 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/opponent's move, not yours/);
    expect(textOf(res)).toContain('try ply 3 or 5');
    expect(engine.searched).toEqual([]);
  });

  it('says plainly when the game is not analysed or the ply is outside it', async () => {
    writeCached(cachedItalian());
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), deepEngine(BC5_BEFORE, NG5_AFTER)));
    const missing = await call(client, 'coach_explain_position', { gameId: 'nope', ply: 1 });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/not.*analysed/i);
    const outside = await call(client, 'coach_explain_position', { gameId: GAME_ID, ply: 99 });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain('0 to 7');
  });

  it('drops the display engine after a failed search, so the next call starts a fresh one', async () => {
    writeCached(cachedItalian());
    const dead: Engine = {
      async evaluate() {
        throw new Error('Stockfish adapter is closed');
      },
    };
    const d = deps(createRunner(NO_ENGINE, source([])), dead);
    const client = await connect(d);
    const res = await call(client, 'coach_explain_position', { gameId: GAME_ID, ply: 5 });
    expect(res.isError).toBe(true);
    expect(d.resets).toEqual([d.display.get()]); // the engine that failed, not whichever is current later
  });
});

describe('coach_engine_status', () => {
  it('reports the engine settings and processes', async () => {
    const client = await connect(deps(createRunner(NO_ENGINE, source([]))));
    const res = await call(client, 'coach_engine_status', {});
    expect(res.structuredContent).toMatchObject({ stockfishPath: '/fake/stockfish', binaryFound: true });
    expect(res.structuredContent?.display).toMatchObject({ depth: 16, threads: 1, multiPv: 3 });
    expect(textOf(res)).toContain('depth 16, 1 thread, MultiPV 3');
    expect(textOf(res)).not.toMatch(/1500 ms per position/);
    expect(textOf(res)).toContain('/fake/stockfish');
  });
});

describe('coach_me prompt', () => {
  it('carries the coaching rules', async () => {
    const client = await connect(deps(createRunner(NO_ENGINE, source([]))));
    const p = await client.getPrompt({ name: 'coach_me', arguments: { username: 'alice' } });
    const text = p.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
    expect(text).toContain('alice');
    for (const rule of [
      'never state a move or evaluation that a tool did not return',
      'always say how many games a finding rests on',
      "say 'not enough data' plainly",
      'one focus at a time',
      'no help during a live game',
      // spec §6b rules
      'never reveal the answer before i try',
      'after the answer, name the thinking error first, then show the refutation',
      'three to five positions of the same pattern',
      'one rule of thumb',
      "never open a practice position with coach_explain_position before i've tried it",
    ]) {
      expect(text.toLowerCase()).toContain(rule);
    }
  });

  it('walks through the session steps 1–8 and only names tools that exist', async () => {
    const client = await connect(deps(createRunner(NO_ENGINE, source([]))));
    const p = await client.getPrompt({ name: 'coach_me', arguments: { username: 'alice' } });
    const text = p.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
    for (let step = 1; step <= 8; step++) expect(text).toMatch(new RegExp(`^${step}\\. `, 'm'));
    for (const step of ['Report card', 'Warm-up', "Today's theme", 'try first', 'Practice', 'rule of thumb', 'Homework', 'next session']) {
      expect(text).toContain(step);
    }
    // Several accounts are passed as `accounts`, asked once, with a stated default.
    expect(text).toContain('accounts [{ username, maxGames }');
    expect(text).toContain('the last 300 blitz games');
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const named = [...new Set(text.match(/coach_[a-z_]+/g) ?? [])];
    expect(named.length).toBeGreaterThan(5);
    for (const n of named) expect(names, n).toContain(n);
  });
});

describe('diagnosisText', () => {
  function area(over: Partial<AreaFinding> & Pick<AreaFinding, 'area' | 'label'>): AreaFinding {
    return {
      myRate: 6,
      oppRate: 5,
      gapPts: 1,
      ci95: [-1, 3],
      ciAdj: [-2, 4],
      exactP: 0.5,
      games: 120,
      myGames: 120,
      oppGames: 120,
      myMoves: 900,
      oppMoves: 900,
      notes: ['same games, resampled by game'],
      ...over,
    };
  }
  const D: Diagnosis = {
    usernames: ['alice'],
    timeClass: 'blitz',
    games: 300,
    asOf: 1_700_000_000,
    areas: [
      area({ area: 'opening', label: 'notYourProblem', myRate: 2.14, oppRate: 2.43, games: 300 }),
      area({ area: 'middlegame', label: 'gap', myRate: 6.9, oppRate: 5.5, gapPts: 1.4, ci95: [0.6, 2.2], ciAdj: [0.2, 2.6] }),
      area({ area: 'endgame', label: 'gap', myRate: 9.4, oppRate: 5.6, gapPts: 3.8, ci95: [2.2, 5.5], ciAdj: [1.3, 6.4], games: 141 }),
      area({ area: 'converting', label: 'noClearDifference' }),
      area({ area: 'timePressure', label: 'notEnoughData', myRate: 15, oppRate: 12, games: 19 }),
    ],
    repeated: [],
    focus: { kind: 'area', area: 'endgame' },
    notes: ['Based on 300 games, comparing you with players at your rating in the same games.'],
  };

  it('is a plain-words table with game counts, and calls a clear gap under 2 points small but real', () => {
    const text = diagnosisText(diagnosisView(D, [], []));
    const row = (name: RegExp) => text.split('\n').find((l) => name.test(l)) ?? '';
    expect(text).toContain('300 blitz games');
    expect(row(/opening/i)).toMatch(/not a weak spot\s*\|\s*2\.1\s*\|\s*2\.4\s*\|\s*300/);
    expect(row(/middlegame/i)).toContain('small but real');
    expect(row(/endgame/i)).toMatch(/weak spot/);
    expect(row(/endgame/i)).not.toContain('small but real');
    expect(row(/converting/i)).toContain('too close to call');
    expect(row(/time pressure/i)).toMatch(/not enough data\s*\|\s*–\s*\|\s*–\s*\|\s*19/);
    expect(text).toMatch(/players at your rating/i);
  });

  const REPEATED: Diagnosis = {
    ...D,
    focus: { kind: 'repeated', keys: ['k1'] },
    notes: [...D.notes, 'Focus: the position you keep getting wrong.'],
    repeated: [
      {
        key: 'k1',
        fen: 'x',
        movesFromStart: ['e4', 'c5'],
        seen: 5,
        wrong: 4,
        avgLossPts: 12.3,
        usual: [{ move: 'Nc3', times: 3, lossPts: 11.4 }],
        best: 'Qxd5', // quick search (ENGINE_CFG): must never reach the model
        gameIds: ['g1', 'g2'],
      },
    ],
  };

  it('prints one focus line, even when a note restates it', () => {
    const text = diagnosisText(diagnosisView(REPEATED, [], [{ gameId: 'g2', ply: 2 }]));
    expect(text.split('\n').filter((l) => /^-?\s*Focus:/.test(l))).toHaveLength(1);
  });

  it('repeated positions: game moves, approximate quick-check losses and a reference; never the quick-search best move', () => {
    const ex = [{ gameId: 'g1', ply: 32, moveNumber: 17, mover: 'white' as const, playedSan: 'Rxe4', gameUrl: 'https://example.test/g1' }];
    const view = diagnosisView(REPEATED, ex, [{ gameId: 'g2', ply: 2 }]);
    const text = diagnosisText(view);
    expect(text).toContain(
      '1. [focus] After 1. e4 c5: you had to move here in 5 games and went wrong 4 times, losing about 12% win chance each time (quick check).',
    );
    expect(text).toContain('Your moves there: Nc3 3 times (about 11% each time).');
    expect(text).toContain('To show it: gameId g2, ply 2.');
    expect(text).toContain('gameId g1, ply 32: you played 17. Rxe4 as White');
    expect(text).not.toContain('Qxd5');
    // The structured copy has no `best` either, and names the losses approximate.
    expect(JSON.stringify(view)).not.toContain('Qxd5');
    expect(view.repeated[0]).not.toHaveProperty('best');
    expect(view.repeated[0]).toMatchObject({ approxAvgLossPts: 12.3, usual: [{ move: 'Nc3', times: 3, approxLossPts: 11.4 }], example: { gameId: 'g2', ply: 2 } });
  });

  it('writes out at most 10 repeated positions (all stay in the structured data), and says "once" for a single move', () => {
    const base = REPEATED.repeated[0];
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...base,
      key: `k${i}`,
      usual: [{ move: 'Nc3', times: 1, lossPts: 22.6 }],
    }));
    const view = diagnosisView({ ...REPEATED, repeated: many, focus: { kind: 'repeated', keys: ['k0'] } }, [], []);
    const text = diagnosisText(view);
    expect(text).toContain('Your moves there: Nc3 once (about 23%).');
    expect(text).toContain('10. After');
    expect(text).not.toContain('11. After');
    expect(text).toContain('…and 2 more positions like these, in the structured data.');
    expect(text.match(/^\d+\. \[focus\]/gm)).toHaveLength(1);
    expect(view.repeated).toHaveLength(12);
  });
});

// ---- the coaching session (C1b) ----

/** A deep engine keyed by position (board, side to move, castling, en passant), recording every search. */
function keyedEngine(byFen: Record<string, Evaluation | Evaluation[]>): Engine & { searched: string[] } {
  const byKey = new Map(Object.entries(byFen).map(([fen, e]) => [positionKey(fen), e]));
  const searched: string[] = [];
  return {
    searched,
    async evaluate(fen) {
      searched.push(fen);
      const e = byKey.get(positionKey(fen));
      if (!e) throw new Error(`unexpected search ${fen}`);
      // A list gives a different answer on each search, like 2-thread Stockfish choosing between equal moves.
      return Array.isArray(e) ? e[(searched.filter((f) => positionKey(f) === positionKey(fen)).length - 1) % e.length] : e;
    },
  };
}

const fenAt = (sans: string[], n: number) => {
  const b = new Chess();
  for (const s of sans.slice(0, n)) b.move(s);
  return b.fen();
};
// Ply 7 of the Italian fixture: Black's ...d5 after 4.Ng5 (the quick check called it a mistake).
const FEN_BEFORE_7 = fenAt(SANS, 7);
const FEN_AFTER_7 = fenAt(SANS, 8);
const QE7_BEFORE: Evaluation = { cp: -50, mate: null, bestMoveUci: 'd8e7', secondBest: null, pvUci: ['d8e7'] };
const D5_AFTER: Evaluation = { cp: 250, mate: null, bestMoveUci: 'e4d5', secondBest: null, pvUci: ['e4d5', 'c6a5'] };
// The deep check clears ply 5: ...Nf6 is its own first choice.
const NF6_BEST: Evaluation = { cp: 20, mate: null, bestMoveUci: 'g8f6', secondBest: null, pvUci: ['g8f6', 'f3g5'] };
const NF6_HOLDS: Evaluation = { cp: -20, mate: null, bestMoveUci: 'f3g5', secondBest: null, pvUci: ['f3g5', 'd7d5'] };
const H6_AFTER: Evaluation = { cp: 120, mate: null, bestMoveUci: 'd2d4', secondBest: null, pvUci: ['d2d4', 'e5d4'] };

/** The answer and everything engine-made about it, none of which may show before the player tries. */
const ANSWER_BITS = ['Bc5', 'f8c5', 'Nf6', 'g8f6', 'Be7', 'Ng5', 'f3g5', 'Qe7', 'd8e7', '%', 'mistake', 'blunder', 'best'];

/** The italian fixture as cached, diagnosed with the opening as its focus (both of Black's moves there are mistakes). */
function italianLesson(engine: Engine) {
  const c = cachedItalian();
  writeCached(c);
  const runner = createRunner(NO_ENGINE, source([c.game]));
  const openingFocus: typeof diagnose = (g, u, b) => ({ ...diagnose(g, u, b), focus: { kind: 'area', area: 'opening' } });
  return { c, runner, deps: { ...deps(runner, engine), diagnose: openingFocus } };
}

describe('coach_ask_position', () => {
  it('askPositionToolLeaksNoAnswer: the question carries the board only; text and structuredContent hold no answer', async () => {
    writeCached(cachedItalian());
    const engine = deepEngine(BC5_BEFORE, NG5_AFTER);
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine));
    const { tools } = await client.listTools();
    for (const name of ['coach_ask_position', 'coach_check_move', 'coach_report']) {
      const t = tools.find((x) => x.name === name);
      expect((t?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(BOARD_URI);
    }

    const res = await call(client, 'coach_ask_position', { gameId: GAME_ID, ply: 5 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({
      kind: 'question',
      fen: FEN_BEFORE_5,
      orientation: 'black',
      gameId: GAME_ID,
      ply: 5,
      prompt: 'What would you play here, and what were you worried about?',
    });
    const text = textOf(res);
    expect(text).toContain(FEN_BEFORE_5);
    expect(text).toContain('coach_check_move');
    for (const bit of ANSWER_BITS) {
      expect(text).not.toContain(bit);
      expect(JSON.stringify(res.structuredContent)).not.toContain(bit);
    }
    // It was deep-checked before being asked (and only asked because the move really was a mistake).
    expect(engine.searched).toEqual([FEN_BEFORE_5, FEN_AFTER_5]);
  });

  it('skipsPositionsThatAreNotRealMistakes: picks the next practice position, passing over one the deep check clears', async () => {
    const engine = keyedEngine({
      [FEN_BEFORE_5]: NF6_BEST,
      [FEN_AFTER_5]: NF6_HOLDS,
      [FEN_BEFORE_7]: QE7_BEFORE,
      [FEN_AFTER_7]: D5_AFTER,
    });
    const { runner, deps: d } = italianLesson(engine);
    const client = await connect(d);
    const none = await call(client, 'coach_ask_position', {});
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/call coach_report/);

    expect((await call(client, 'coach_report', ALICE)).isError).toBeFalsy();
    const res = await call(client, 'coach_ask_position', {});
    expect(res.isError).toBeFalsy();
    // Ply 5 (the worse loss) comes first, but the deep check clears it; ply 7 is a real mistake.
    expect(res.structuredContent).toMatchObject({ kind: 'question', gameId: GAME_ID, ply: 7, fen: FEN_BEFORE_7 });
    for (const bit of ['Qe7', 'd8e7', 'd5', '%']) expect(textOf(res)).not.toContain(bit);

    // Both are now used up for this lesson.
    const done = await call(client, 'coach_ask_position', {});
    expect(done.isError).toBe(true);
    expect(textOf(done)).toMatch(/No more practice positions/);

    // Asked by reference, a position the deep check clears is refused without naming a move.
    const cleared = await call(client, 'coach_ask_position', { gameId: GAME_ID, ply: 5 });
    expect(cleared.isError).toBe(true);
    expect(textOf(cleared)).toMatch(/didn't really go wrong/);
    for (const bit of ['Nf6', 'g8f6', 'Ng5']) expect(textOf(cleared)).not.toContain(bit);
    await runner.close();
  });

  it('brings back a position answered right in an earlier session (spacing), but not within the same session', async () => {
    const engine = keyedEngine({
      [FEN_BEFORE_5]: NF6_BEST,
      [FEN_AFTER_5]: NF6_HOLDS,
      [FEN_BEFORE_7]: QE7_BEFORE,
      [FEN_AFTER_7]: D5_AFTER,
    });
    const one = italianLesson(engine);
    const first = await connect(one.deps);
    await call(first, 'coach_report', ALICE);
    expect((await call(first, 'coach_ask_position', {})).structuredContent).toMatchObject({ ply: 7 });
    const right = await call(first, 'coach_check_move', { gameId: GAME_ID, ply: 7, moveSan: 'Qe7' });
    expect(right.structuredContent).toMatchObject({ correct: true });
    expect((await call(first, 'coach_ask_position', {})).isError).toBe(true);

    // The next server session: right once is not learned yet, so it is practised again.
    const runner2 = createRunner(NO_ENGINE, source([one.c.game]));
    const second = await connect({ ...one.deps, runner: runner2 });
    await call(second, 'coach_report', ALICE);
    expect((await call(second, 'coach_ask_position', {})).structuredContent).toMatchObject({ ply: 7 });
    await one.runner.close();
    await runner2.close();
  });
});

describe('coach_check_move', () => {
  it('checkMoveAlwaysPassesAttempt: the answer board shows the try against the best move, and the try is recorded', async () => {
    const engine = keyedEngine({ [FEN_BEFORE_5]: BC5_BEFORE, [FEN_AFTER_5]: NG5_AFTER, [new Chess(FEN_BEFORE_5).move('h6').after]: H6_AFTER });
    writeCached(cachedItalian());
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine));

    const wrong = await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 5, moveSan: 'h6' });
    expect(wrong.isError).toBeFalsy();
    expect(wrong.structuredContent).toMatchObject({
      kind: 'answer',
      fen: FEN_BEFORE_5,
      playedUci: 'h7h6',
      playedSan: 'h6',
      bestUci: 'f8c5',
      bestSan: 'Bc5',
      winAfter: null, // the facts' win-after belongs to the game move, not the try
      correct: false,
    });
    expect(String(wrong.structuredContent?.caption)).toContain('You tried h6; the best move is Bc5.');
    const text = textOf(wrong);
    const keeps = /Your move keeps about (\d+)% win chance; the best move keeps (\d+)%\./.exec(text);
    expect(keeps).not.toBeNull();
    expect(Number(keeps![1])).toBe(Math.round(100 - evalToWinPct(120, null)));
    expect(Number(keeps![2])).toBe(Math.round(evalToWinPct(80, null)));
    expect(text).toContain("The opponent's strongest reply to h6: 4. d4 exd4.");
    expect(text).toContain('In the game the player chose Nf6');
    expect(text).not.toContain('Be7'); // the quick search's best move never shows

    const best = await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 5, moveSan: 'Bc5' });
    expect(best.structuredContent).toMatchObject({ kind: 'answer', playedUci: 'f8c5', playedSan: 'Bc5', bestUci: null, correct: true, lossPts: 0 });
    expect(String(best.structuredContent?.caption)).toContain('Bc5 is the best move here.');
    expect(textOf(best)).toContain("Right: that is Stockfish's best move.");

    // Only the first try is recorded, in the student file of the game's account (no player named yet).
    expect(textOf(wrong)).toContain("Recorded in alice's student file: 0 of 1 right this session.");
    expect(textOf(best)).toContain('Not recorded: only your first try at a position counts (0 of 1 right this session).');
    const s = loadStudent('alice');
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].tried.map((t) => [t.moveSan, t.correct, t.key])).toEqual([['h6', false, positionKey(FEN_BEFORE_5)]]);
  });

  it('refuses an illegal move plainly and records nothing', async () => {
    writeCached(cachedItalian());
    const engine = deepEngine(BC5_BEFORE, NG5_AFTER);
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine));
    const res = await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 5, moveSan: 'Ke2' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a legal move/);
    expect(engine.searched).toEqual([]);
    expect(loadStudent('alice').sessions).toEqual([]);
  });

  it('deepFactsCachedPerFen: one search per position for the whole session, even across games and changing answers', async () => {
    // Game B reaches the same board as the fixture by another move order (different move counters).
    const B_SANS = ['Nf3', 'Nc6', 'e4', 'e5', 'Bc4', 'Nf6', 'Ng5', 'd5'];
    const B_ID = 'https://example.test/game/live/43';
    const b = fixtureGame({ id: B_ID, sans: B_SANS, wins: [52, 50, 54, 52, 55, 66, 60, 70], myColor: 'black' });
    writeCached(b);
    writeCached(cachedItalian());
    expect(fenAt(B_SANS, 5)).not.toBe(FEN_BEFORE_5);
    expect(positionKey(fenAt(B_SANS, 5))).toBe(positionKey(FEN_BEFORE_5));
    // A second search of the position would name Be7 instead of Bc5.
    const engine = keyedEngine({
      [FEN_BEFORE_5]: [BC5_BEFORE, { cp: 80, mate: null, bestMoveUci: 'f8e7', secondBest: null, pvUci: ['f8e7'] }],
      [FEN_AFTER_5]: NG5_AFTER,
    });
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine));
    const explainA = await call(client, 'coach_explain_position', { gameId: GAME_ID, ply: 5 });
    const askB = await call(client, 'coach_ask_position', { gameId: B_ID, ply: 5 });
    const checkB = await call(client, 'coach_check_move', { gameId: B_ID, ply: 5, moveSan: 'Nf6' });
    expect(explainA.structuredContent).toMatchObject({ bestSan: 'Bc5' });
    expect(askB.isError).toBeFalsy();
    expect(checkB.structuredContent).toMatchObject({ bestSan: 'Bc5', bestUci: 'f8c5' });
    expect(engine.searched.map(positionKey)).toEqual([positionKey(FEN_BEFORE_5), positionKey(FEN_AFTER_5)]);
  });
});

describe('first tries and sessions', () => {
  const H6 = new Chess(FEN_BEFORE_5).move('h6').after;
  const engine = () => keyedEngine({ [FEN_BEFORE_5]: BC5_BEFORE, [FEN_AFTER_5]: NG5_AFTER, [H6]: H6_AFTER });

  it('retryWithSameMoveNotRecorded: the same try twice is scored twice but recorded once', async () => {
    writeCached(cachedItalian());
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine()));
    const a = await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 5, moveSan: 'h6' });
    const b = await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 5, moveSan: 'h6' });
    expect(b.structuredContent).toMatchObject({ kind: 'answer', playedSan: 'h6', correct: false });
    expect(textOf(a)).toContain('Recorded in');
    expect(textOf(b)).toContain('Not recorded: only your first try at a position counts');
    expect(loadStudent('alice').sessions[0].tried).toHaveLength(1);
  });

  it('retryAfterRevealNotCountedRight: right after the answer was shown is scored right but never counted', async () => {
    writeCached(cachedItalian());
    // The same board reached in another game counts as the same position.
    const b = fixtureGame({ id: 'https://example.test/game/live/44', sans: ['Nf3', 'Nc6', 'e4', 'e5', 'Bc4', 'Nf6'], myColor: 'black' });
    writeCached(b);
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine()));
    await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 5, moveSan: 'h6' });
    const after = await call(client, 'coach_check_move', { gameId: b.game.id, ply: 5, moveSan: 'Bc5' });
    expect(after.structuredContent).toMatchObject({ correct: true });
    expect(textOf(after)).toContain("Right: that is Stockfish's best move.");
    expect(textOf(after)).toContain('Not recorded: only your first try at a position counts (0 of 1 right this session).');
    const s = loadStudent('alice');
    expect(s.sessions[0].tried.map((t) => t.correct)).toEqual([false]);
    expect(rightSessionsByBoard(s, new Map()).size).toBe(0);
    // The next server session reports it as wrong last time.
    const next = await connect(deps(createRunner(NO_ENGINE, source([])), engine()));
    expect(textOf(await call(next, 'coach_student', { username: 'alice' }))).toContain('0 of 1 right.');
  });

  it('one server across a session rollover: asked positions come back, cleared ones stay out, a new session is written', async () => {
    let clock = Date.UTC(2026, 10, 22, 18);
    const eng = keyedEngine({
      [FEN_BEFORE_5]: NF6_BEST,
      [FEN_AFTER_5]: NF6_HOLDS,
      [FEN_BEFORE_7]: QE7_BEFORE,
      [FEN_AFTER_7]: D5_AFTER,
    });
    const lesson = italianLesson(eng);
    const client = await connect({ ...lesson.deps, now: () => clock });
    await call(client, 'coach_report', ALICE);
    expect((await call(client, 'coach_ask_position', {})).structuredContent).toMatchObject({ ply: 7 });
    expect((await call(client, 'coach_ask_position', {})).isError).toBe(true); // ply 5 cleared, ply 7 asked

    clock += 4 * 60 * 60 * 1000; // past the 3 h idle line: a new student session
    const again = await call(client, 'coach_ask_position', {});
    expect(again.structuredContent).toMatchObject({ ply: 7 });
    await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 7, moveSan: 'Qe7' });
    expect(loadStudent('alice').sessions).toHaveLength(1); // nothing was written in the first session
    // Ply 5 was cleared at depth once, and stays out without a second search.
    expect(eng.searched.filter((f) => positionKey(f) === positionKey(FEN_BEFORE_5))).toHaveLength(1);

    clock += 4 * 60 * 60 * 1000;
    expect((await call(client, 'coach_ask_position', {})).structuredContent).toMatchObject({ ply: 7 }); // right once: not learned
    await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 7, moveSan: 'Qe7' });
    expect(loadStudent('alice').sessions).toHaveLength(2);
    await lesson.runner.close();
  });

  it('the player is always the primary account; a bad name is refused and changes nothing', async () => {
    writeCached(cachedItalian());
    const runner = createRunner(NO_ENGINE, source([], undefined, { alice: [], alice2: [] }));
    const client = await connect(deps(runner, engine()));
    await call(client, 'coach_diagnosis', { accounts: [{ username: 'alice', maxGames: 5 }, { username: 'Alice2', maxGames: 5 }] });
    const res = await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 5, moveSan: 'Bc5', username: 'alice2' });
    expect(textOf(res)).toContain("Recorded in alice's student file");
    const bad = await call(client, 'coach_note_thinking', { note: 'rushed', username: '../x' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/not a Chess.com username/);
    expect(textOf(await call(client, 'coach_note_thinking', { note: 'rushed' }))).toContain("Saved in alice's student file");
    await runner.close();
  });

  it('an ambiguous or illegal move is refused before any engine starts', async () => {
    writeCached(cachedItalian());
    let gets = 0;
    const d = deps(createRunner(NO_ENGINE, source([])), engine());
    const counted = { ...d, display: { get: () => (gets++, d.display.get()), reset: d.display.reset } };
    const client = await connect(counted);
    for (const bad of ['Ne7', 'Ke2']) {
      // Black to move: both knights (c6 and g8) can go to e7.
      const res = await call(client, 'coach_check_move', { gameId: GAME_ID, ply: 5, moveSan: bad });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(`"${bad}" is not a legal move here, or it is ambiguous (which piece?).`);
    }
    expect(gets).toBe(0);
    expect(loadStudent('alice').sessions).toEqual([]);
  });

  it('near the 5-point line the loss shows one decimal, so a wrong verdict never reads "at most 5%"', () => {
    const facts = {
      gameId: GAME_ID, ply: 5, fenBefore: FEN_BEFORE_5, fenAfter: FEN_AFTER_5, mover: 'black' as const,
      playedSan: 'Nf6', playedUci: 'g8f6', bestSan: 'Bc5', bestUci: 'f8c5', bestLineSan: ['Bc5'],
      refutationSan: null, winBefore: 57, winAfter: 36, classification: 'blunder' as const, reason: null, gameUrl: GAME_ID,
    };
    const result = (lossPts: number, correct: boolean) => ({
      legal: true as const, correct, lossPts, playedInGame: 'Nf6', facts, attempt: { moveSan: 'h6', moveUci: 'h7h6' },
      attemptWin: 57 - lossPts, bestWin: 57, isBest: false, isGameMove: false, attemptRefutationSan: null,
    });
    expect(checkText(result(5.2, false), null)).toContain('Not right: it loses about 5.2% win chance');
    expect(checkText(result(7.4, false), null)).toContain('Not right: it loses about 7% win chance');
    expect(checkText(result(4.6, true), null)).toContain('Right: it is within 5% of the best move (it loses about 5%).');
  });
});

describe('coach_report', () => {
  it('shows the report card with words from the diagnosis and a text table; a status view while games are analysed', async () => {
    const c = cachedGame('https://example.test/game/r1', 'alice');
    const client = await connect(deps(createRunner(NO_ENGINE, source([c.game])), keyedEngine({})));
    const res = await call(client, 'coach_report', ALICE);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      kind: 'report',
      games: 1,
      timeClass: 'blitz',
      focus: null,
      headline: 'Not enough games yet to judge.',
      subhead: '1 blitz game so far; each part of the game needs at least 30 games.',
      positions: [],
      cta: "Start this week's training",
    });
    expect(textOf(res)).toContain('| Area | Verdict |');
    expect(textOf(res)).toMatch(/nothing to practise/);
    const own = await call(client, 'coach_report', { ...ALICE, headline: 'One game is not enough to judge yet.' });
    expect(own.structuredContent?.headline).toBe('One game is not enough to judge yet.');

    const gate = deferred();
    const runner = createRunner(() => gatedEngine(gate.promise), source([game(1), game(2)]));
    const busy = await connect(deps(runner));
    let r: CallResult | undefined;
    try {
      r = await call(busy, 'coach_report', ALICE);
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toEqual({
        kind: 'status',
        title: 'Still analysing your games',
        message: 'Analysed 0 of 2 games. Ask for the report again in a minute.',
        progress: { done: 0, total: 2 },
      });
      expect(textOf(r)).toBe('Analysed 0 of 2 games. Ask for the report again in a minute.');
    } finally {
      gate.resolve();
      const first = await call(busy, 'coach_diagnosis', ALICE);
      await waitAll(runner, first);
      await runner.close();
    }
  });

  it('reportWords: names a gap plainly (small but real under 2 points); otherwise the rating is honest', () => {
    const base: Diagnosis = {
      usernames: ['alice'],
      timeClass: 'blitz',
      games: 300,
      asOf: 0,
      areas: [],
      repeated: [],
      focus: null,
      notes: [],
    };
    const row = (over: Partial<AreaFinding> & Pick<AreaFinding, 'area' | 'label'>): AreaFinding => ({
      myRate: 9.4, oppRate: 5.6, gapPts: 3.8, ci95: [2, 5], ciAdj: [1, 6], exactP: 0.001, games: 141,
      myGames: 141, oppGames: 141, myMoves: 900, oppMoves: 900, notes: [], ...over,
    });
    const gap = { ...base, areas: [row({ area: 'endgame', label: 'gap' })], focus: { kind: 'area' as const, area: 'endgame' as const } };
    expect(reportWords(gap, 0)).toEqual({
      headline: 'Your weak spot: your endgames.',
      subhead: 'There, 9.4% of your moves are serious mistakes, against 5.6% for players at your rating (300 blitz games).',
    });
    const small = { ...gap, areas: [row({ area: 'endgame', label: 'gap', gapPts: 1.4, myRate: 7, oppRate: 5.6 })] };
    expect(reportWords(small, 0).headline).toBe('A small but real weak spot: your endgames.');
    const honest = { ...base, areas: [row({ area: 'endgame', label: 'notYourProblem' })], focus: { kind: 'repeated' as const, keys: ['k'] } };
    expect(reportWords(honest, 2)).toEqual({
      headline: 'Your rating is honest. Your points leak from 2 positions.',
      subhead: 'Against players at your rating, no part of your game stands out (300 blitz games).',
    });
  });

  it('report and diagnosis text never give away a practice position: no wrong or best move, no reference', async () => {
    // alice (White) keeps reaching the position after 1.e4 e5 2.Nf3 Nc6 and goes wrong: Bc4 twice, Na3 once.
    const OPEN = ['e4', 'e5', 'Nf3', 'Nc6'];
    const played = ['Bc4', 'Bc4', 'Na3'];
    const games = played.map((m, i) => {
      const c = fixtureGame({
        id: `https://example.test/game/rep${i}`,
        sans: [...OPEN, m, 'Nf6'],
        wins: [50, 50, 50, 50, 38, 38], // White loses 12 with the move at ply 4
        endTime: 1_700_000_000 + i,
      });
      c.game.pgn = '[ECOUrl "https://www.chess.com/openings/Italian-Game"]\n\n*';
      writeCached(c);
      return c;
    });
    const P = fenAt([...OPEN], 4);
    const engine = keyedEngine({
      [P]: { cp: 60, mate: null, bestMoveUci: 'd2d4', secondBest: null, pvUci: ['d2d4', 'e5d4'] },
      [new Chess(P).move('Bc4').after]: { cp: 30, mate: null, bestMoveUci: 'f8c5', secondBest: null, pvUci: ['f8c5'] },
      [new Chess(P).move('Na3').after]: { cp: 120, mate: null, bestMoveUci: 'd7d5', secondBest: null, pvUci: ['d7d5'] },
    });
    const runner = createRunner(NO_ENGINE, source(games.map((c) => c.game)));
    const client = await connect(deps(runner, engine));
    const diag = await call(client, 'coach_diagnosis', ALICE);
    const report = await call(client, 'coach_report', ALICE);
    expect(report.structuredContent).toMatchObject({ kind: 'report', focus: 'the position you keep getting wrong' });
    // The card itself shows the mission (by design), with the deep best move.
    expect(report.structuredContent?.positions).toMatchObject([{ wrongSan: ['Bc4', 'Na3'], bestSan: 'd4', opening: 'Italian Game' }]);
    expect(report.structuredContent?.headline).toBe('Not enough games yet to judge.'); // 3 games: no area can be judged

    for (const text of [textOf(diag), textOf(report)]) {
      expect(text).toContain("These are today's practice positions; coach_ask_position asks them");
      for (const move of [/\bBc4\b/, /\bNa3\b/, /\bd4\b/, /\bNc3\b/, /f1c4/, /d2d4/, /gameId https?:/, /\bply \d/, /coach_explain_position/]) {
        expect(text).not.toMatch(move);
      }
    }
    // The diagnosis' structured copy holds no moves played there and no references either.
    expect(JSON.stringify(diag.structuredContent)).not.toMatch(/Bc4|Na3|"example":\{|rep\d#/);
    expect(diag.structuredContent?.examples).toEqual([]);
    await runner.close();
  });
});

describe('student memory tools', () => {
  it('coach_note_thinking and coach_student: this session is kept apart from "last time"', async () => {
    writeCached(cachedItalian());
    const engine = deepEngine(BC5_BEFORE, NG5_AFTER);
    const first = await connect(deps(createRunner(NO_ENGINE, source([])), engine));
    expect(textOf(await call(first, 'coach_student', { username: 'alice' }))).toMatch(/No earlier sessions for alice/);
    await call(first, 'coach_check_move', { gameId: GAME_ID, ply: 5, moveSan: 'Nf6', username: 'Alice' });
    const noted = await call(first, 'coach_note_thinking', { note: "didn't ask what the knight threatened", rule: 'Ask what their last move threatens.' });
    expect(noted.isError).toBeFalsy();
    expect(textOf(noted)).toContain("Saved in alice's student file: 1 thinking note this session; rule of thumb set.");
    const same = textOf(await call(first, 'coach_student', {}));
    expect(same).toMatch(/No earlier sessions/);
    expect(same).toContain('This session so far: 0 of 1 right.');
    expect(textOf(await call(first, 'coach_note_thinking', {}))).toMatch(/Give a note/);

    // A new server session: the last one is now "last time".
    const next = await connect(deps(createRunner(NO_ENGINE, source([])), engine));
    const res = await call(next, 'coach_student', { username: 'alice' });
    const text = textOf(res);
    // The warm-up comes first; last time's line and notes are for after the try.
    expect(text).toMatch(new RegExp(`^Warm-up first: ask gameId ${GAME_ID}, ply 5 again with coach_ask_position`));
    expect(text).toMatch(/\nLast time \(\d{4}-\d{2}-\d{2}\): 0 of 1 right\./);
    expect(text.indexOf('Warm-up first')).toBeLessThan(text.indexOf("didn't ask what the knight threatened"));
    expect(text).toContain('Rule of thumb: Ask what their last move threatens.');
    expect(res.structuredContent).toMatchObject({ warmUp: { gameId: GAME_ID, ply: 5 }, last: { right: 0, tried: 1 } });
  });
});
