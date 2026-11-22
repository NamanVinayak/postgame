import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Engine, Evaluation } from '../../../src/services/engine/types';
import type { Classification } from '../../../src/types';
import { writeCached } from '../analysis/cache';
import { createRunner, type Runner } from '../analysis/runner';
import type { AreaFinding, Diagnosis } from '../diagnosis/diagnose';
import { fixtureGame } from '../diagnosis/testGames';
import type { CoachGame, GameSource } from '../sources/types';
import { BOARD_URI } from './boardResource';
import { diagnosisText, registerCoachTools, type CoachDeps, type EngineInfo } from './tools';

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

function source(games: CoachGame[], gate?: Promise<void>): GameSource {
  return {
    async fetchGames() {
      if (gate) await gate;
      return games;
    },
  };
}

const ENGINE_INFO: EngineInfo = {
  stockfishPath: '/fake/stockfish',
  binaryFound: true,
  analysis: { running: false, positionsSearched: 0 },
  display: { running: false, positionsSearched: 0 },
};

function deps(runner: Runner, display: Engine | null = null): CoachDeps & { resets: Engine[] } {
  const d = {
    resets: [] as Engine[],
    runner,
    display: {
      get(): Engine {
        if (!display) throw new Error('no display engine in this test');
        return display;
      },
      reset(failed: Engine) {
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

const NO_ENGINE = () => {
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

describe('coach_diagnosis', () => {
  it('diagnosisReturnsProgressWhileRunning', async () => {
    const gate = deferred();
    const runner = createRunner(() => gatedEngine(gate.promise), source([game(1), game(2), game(3)]));
    const client = await connect(deps(runner));
    let jobId: string | undefined;
    try {
      const t0 = Date.now();
      const res = (await client.callTool({ name: 'coach_diagnosis', arguments: ALICE })) as CallResult;
      const ms = Date.now() - t0;
      expect(ms).toBeLessThan(2000);
      expect(res.isError).toBeFalsy();
      const text = textOf(res);
      expect(text).toContain('analysed');
      expect(text).toContain(' of ');
      expect(text).toMatch(/analysed 0 of 3 games so far/);
      expect(res.structuredContent).toMatchObject({ state: 'running', done: 0, total: 3 });
      jobId = res.structuredContent?.jobId as string;
      expect(typeof jobId).toBe('string');
    } finally {
      gate.resolve();
      if (jobId) await runner.wait(jobId);
      await runner.close();
    }

    // Once the job is done, the same call gives the diagnosis (3 games: nothing can be judged yet).
    const done = (await client.callTool({ name: 'coach_diagnosis', arguments: ALICE })) as CallResult;
    expect(done.structuredContent).toMatchObject({ games: 3, usernames: ['alice'] });
    expect(textOf(done)).toContain('not enough data');
    expect(textOf(done)).toContain('3 blitz games');
  });

  it('answers within 2 s while the game list is still being fetched', async () => {
    const gate = deferred();
    const runner = createRunner(() => gatedEngine(Promise.resolve()), source([game(1)], gate.promise));
    const client = await connect(deps(runner));
    try {
      const t0 = Date.now();
      const res = (await client.callTool({ name: 'coach_diagnosis', arguments: ALICE })) as CallResult;
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(textOf(res)).toMatch(/fetching/i);
      expect(res.structuredContent).toMatchObject({ state: 'fetching' });
    } finally {
      gate.resolve();
      // The start the first call made carries on; wait for it through the tool itself.
      for (let i = 0; i < 100; i++) {
        const r = (await client.callTool({ name: 'coach_diagnosis', arguments: ALICE })) as CallResult;
        if (r.structuredContent?.games === 1) break;
        await new Promise((res) => setTimeout(res, 20));
      }
      await runner.close();
    }
  });

  it('rejects an asOf that is not a real date', async () => {
    const client = await connect(deps(createRunner(NO_ENGINE, source([]))));
    const res = (await client.callTool({ name: 'coach_diagnosis', arguments: { ...ALICE, asOf: '2026-13-45' } })) as CallResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a real date/);
  });

  it('reports a failed analysis plainly', async () => {
    const broken: Engine = {
      async evaluate() {
        throw new Error('Stockfish exited unexpectedly');
      },
    };
    const runner = createRunner(() => broken, source([game(1)]));
    const client = await connect(deps(runner));
    const first = (await client.callTool({ name: 'coach_start_analysis', arguments: ALICE })) as CallResult;
    await runner.wait(first.structuredContent?.jobId as string);
    const res = (await client.callTool({ name: 'coach_diagnosis', arguments: ALICE })) as CallResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Stockfish exited unexpectedly');
    await runner.close();
  });
});

describe('coach_start_analysis', () => {
  it('starts the job and says how many games are cached and left', async () => {
    const runner = createRunner(() => gatedEngine(Promise.resolve()), source([game(1), game(2)]));
    const client = await connect(deps(runner));
    const res = (await client.callTool({ name: 'coach_start_analysis', arguments: { usernames: ['alice'] } })) as CallResult;
    // Finish the job before any assertion can fail, so nothing writes after the temp home is gone.
    await runner.wait(res.structuredContent?.jobId as string);
    await runner.close();
    expect(res.structuredContent).toMatchObject({ total: 2, cached: 0 });
    expect(textOf(res)).toContain('2 blitz games');
  });

  it('refuses a batch over 50 games when memory is low', async () => {
    const runner = createRunner(NO_ENGINE, source([game(1)]));
    const d = { ...deps(runner), freeMemoryPct: () => 12 };
    const client = await connect(d);
    const res = (await client.callTool({ name: 'coach_start_analysis', arguments: ALICE })) as CallResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('12%');
    await runner.close();
  });
});

// Made-up game: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.Ng5 d5. Ply 5 is Black's ...Nf6.
const SANS = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5'];
const FEN_BEFORE_5 = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const FEN_AFTER_5 = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const GAME_ID = 'https://example.test/game/live/42';

function cachedItalian() {
  const best = SANS.map(() => undefined as string | null | undefined);
  best[5] = 'Be7'; // the quick search's choice; the deep search below prefers Bc5
  const cls = SANS.map(() => undefined as Classification | undefined);
  const c = fixtureGame({ id: GAME_ID, sans: SANS, wins: [52, 50, 54, 52, 55, 66, 60, 70], best, cls, myColor: 'black' });
  c.analysis.plies[5].reason = 'A stronger move was Be7.';
  return c;
}

function deepEngine(): Engine & { searched: string[] } {
  const byFen: Record<string, Evaluation> = {
    [FEN_BEFORE_5]: { cp: 80, mate: null, bestMoveUci: 'f8c5', secondBest: null, pvUci: ['f8c5', 'c2c3', 'g8f6'] },
    [FEN_AFTER_5]: { cp: 150, mate: null, bestMoveUci: 'f3g5', secondBest: null, pvUci: ['f3g5', 'd7d5', 'e4d5'] },
  };
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

describe('coach_explain_position', () => {
  it('explainToolCarriesBoardMeta', async () => {
    writeCached(cachedItalian());
    const engine = deepEngine();
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), engine));

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'coach_explain_position');
    expect((tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(BOARD_URI);

    const res = (await client.callTool({ name: 'coach_explain_position', arguments: { gameId: GAME_ID, ply: 5 } })) as CallResult;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.kind).toBe('answer');
    expect(res.structuredContent?.fen).toBe(FEN_BEFORE_5);
    // Everything shown comes from the deep search, never the cached quick one.
    expect(engine.searched).toEqual([FEN_BEFORE_5, FEN_AFTER_5]);
    expect(res.structuredContent).toMatchObject({ playedUci: 'g8f6', bestUci: 'f8c5', bestSan: 'Bc5', orientation: 'black' });
    const text = textOf(res);
    expect(text).toContain('Bc5');
    expect(text).toContain('Ng5');
    expect(text).not.toContain('Be7');
    expect(JSON.stringify(res.structuredContent)).not.toContain('Be7');
  });

  it('says plainly when the game is not analysed or the ply is outside it', async () => {
    writeCached(cachedItalian());
    const client = await connect(deps(createRunner(NO_ENGINE, source([])), deepEngine()));
    const missing = (await client.callTool({ name: 'coach_explain_position', arguments: { gameId: 'nope', ply: 1 } })) as CallResult;
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/not.*analysed/i);
    const outside = (await client.callTool({ name: 'coach_explain_position', arguments: { gameId: GAME_ID, ply: 99 } })) as CallResult;
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
    const res = (await client.callTool({ name: 'coach_explain_position', arguments: { gameId: GAME_ID, ply: 5 } })) as CallResult;
    expect(res.isError).toBe(true);
    expect(d.resets).toEqual([dead]); // the engine that failed, not whichever is current later
  });
});

describe('coach_engine_status', () => {
  it('reports the engine settings and processes', async () => {
    const client = await connect(deps(createRunner(NO_ENGINE, source([]))));
    const res = (await client.callTool({ name: 'coach_engine_status', arguments: {} })) as CallResult;
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
    const text = diagnosisText(D, []);
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

  it('lists repeated positions and examples from the games only, never a quick-search best move', () => {
    const d: Diagnosis = {
      ...D,
      focus: { kind: 'repeated', keys: ['k1'] },
      repeated: [
        {
          key: 'k1',
          fen: 'x',
          movesFromStart: ['e4', 'c5'],
          seen: 5,
          wrong: 4,
          avgLossPts: 12,
          usual: [{ move: 'Nc3', times: 3, lossPts: 11 }],
          best: 'Qxd5', // quick search (ENGINE_CFG): must not be printed
          gameIds: ['g1'],
        },
      ],
    };
    const ex = [{ gameId: 'g1', ply: 32, moveNumber: 17, mover: 'white' as const, playedSan: 'Rxe4', gameUrl: 'https://example.test/g1' }];
    const text = diagnosisText(d, ex);
    expect(text).toContain('After 1. e4 c5: you had to move here in 5 games and went wrong 4 times (you played Nc3 3 times)');
    expect(text).toContain('gameId g1, ply 32: you played 17. Rxe4 as White');
    expect(text).not.toContain('Qxd5');
  });
});
