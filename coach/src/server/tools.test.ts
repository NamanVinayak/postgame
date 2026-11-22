import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Engine, Evaluation } from '../../../src/services/engine/types';
import type { Classification, TimeClass } from '../../../src/types';
import { writeCached, type CachedGame } from '../analysis/cache';
import { memoryGuarded } from '../analysis/memoryPressure';
import { createRunner, type EngineFactory, type Runner } from '../analysis/runner';
import { diagnose, type AreaFinding, type Diagnosis } from '../diagnosis/diagnose';
import { fixtureGame } from '../diagnosis/testGames';
import { createDisplayEngine, type DisplayEngine } from '../engine/displayEngine';
import type { CoachGame, GameSource } from '../sources/types';
import { BOARD_URI } from './boardResource';
import { diagnosisText, diagnosisView, isRealDate, registerCoachTools, type CoachDeps, type EngineInfo } from './tools';

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
    expect(res.structuredContent?.display).toMatchObject({ movetimeMs: 1500, multiPv: 3 });
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
    ]) {
      expect(text.toLowerCase()).toContain(rule);
    }
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
