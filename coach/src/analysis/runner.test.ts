import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Evaluation } from '../../../src/services/engine/types';
import type { TimeClass } from '../../../src/types';
import { ENGINE_CFG, coachHome } from '../config';
import type { CoachGame, GameSource } from '../sources/types';
import { cacheKey, readCached, writeCached } from './cache';
import { createRunner, type Query } from './runner';
import { parseFreeMemoryPct } from './memoryPressure';

const PGN = '[Event "x"]\n\n1. e4 e5 2. Nf3 Nc6 *';
const EVAL: Evaluation = { cp: 20, mate: null, bestMoveUci: 'e2e4', secondBest: null, pvUci: ['e2e4'] };

function game(n: number, username = 'alice'): CoachGame {
  return {
    id: `https://www.chess.com/game/live/${n}`,
    url: `https://www.chess.com/game/live/${n}`,
    timeClass: 'blitz',
    endTime: 1_700_000_000 + n,
    rated: true,
    myColor: 'white',
    outcome: 'win',
    opponent: { username: 'bob', rating: 1500 },
    myRating: 1500,
    pgn: PGN,
    username,
    timeControl: '180+2',
    baseSec: 180,
    incSec: 2,
    myPreRating: 1490,
    clocks: [],
  };
}

function fakeSource(games: CoachGame[]): GameSource & { calls: number } {
  const s = {
    calls: 0,
    async fetchGames() {
      s.calls++;
      return games;
    },
  };
  return s;
}

function fakeEngine() {
  const e = {
    calls: 0,
    closed: 0,
    failNext: 0,
    async evaluate(): Promise<Evaluation> {
      e.calls++;
      if (e.failNext > 0) {
        e.failNext--;
        throw new Error('Stockfish exited unexpectedly (code 1, signal null)');
      }
      return EVAL;
    },
    async close() {
      e.closed++;
    },
  };
  return e;
}

const Q: Query = { usernames: ['alice'], timeClass: 'blitz' as TimeClass, maxGames: 300 };

async function waitDone(runner: ReturnType<typeof createRunner>, jobId: string) {
  for (let i = 0; i < 500; i++) {
    const s = runner.status(jobId);
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not finish');
}

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.POSTGAME_COACH_HOME;
  home = mkdtempSync(join(tmpdir(), 'coach-b3-'));
  process.env.POSTGAME_COACH_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.POSTGAME_COACH_HOME;
  else process.env.POSTGAME_COACH_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('runner', () => {
  it('startReturnsImmediatelyAndAnalysesInBackground', async () => {
    const engine = fakeEngine();
    const runner = createRunner(() => engine, fakeSource([game(1), game(2), game(3)]));
    const t0 = performance.now();
    const started = await runner.start(Q);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(started).toMatchObject({ total: 3, cached: 0 });
    expect(runner.status(started.jobId).state).toBe('running');
    const final = await waitDone(runner, started.jobId);
    expect(final).toMatchObject({ state: 'done', done: 3, total: 3 });
    const loaded = await runner.load(Q);
    expect(loaded.map((c) => c.game.id)).toEqual([game(1).id, game(2).id, game(3).id]);
    expect(loaded[0].analysis.plies.length).toBe(4);
  });

  it('cachedGamesAreNotReanalysed', async () => {
    const engine = fakeEngine();
    const runner = createRunner(() => engine, fakeSource([game(1), game(2), game(3)]));
    const first = await runner.start(Q);
    await waitDone(runner, first.jobId);
    const callsAfterFirst = engine.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await runner.start(Q);
    expect(second.cached).toBe(3);
    expect(second.total).toBe(3);
    await waitDone(runner, second.jobId);
    expect(engine.calls).toBe(callsAfterFirst);
  });

  it('dedupesGamesByIdKeepingFirst', async () => {
    const dup = game(1, 'bob');
    const engine = fakeEngine();
    const runner = createRunner(() => engine, fakeSource([game(1, 'alice'), dup, game(2)]));
    const s = await runner.start({ ...Q, usernames: ['alice', 'bob'] });
    expect(s.total).toBe(2);
    await waitDone(runner, s.jobId);
    const loaded = await runner.load({ ...Q, usernames: ['alice', 'bob'] });
    expect(loaded).toHaveLength(2);
    expect(loaded[0].game.username).toBe('alice');
  });

  it('load returns only cached games, oldest to newest', async () => {
    const engine = fakeEngine();
    const runner = createRunner(() => engine, fakeSource([game(2), game(1)]));
    expect(await runner.load(Q)).toEqual([]);
    const s = await runner.start(Q);
    await waitDone(runner, s.jobId);
    const loaded = await runner.load(Q);
    expect(loaded.map((c) => c.game.endTime)).toEqual([game(1).endTime, game(2).endTime]);
  });

  it('recreatesEngineOnceAfterDeathAndRetriesTheGame', async () => {
    const engines: ReturnType<typeof fakeEngine>[] = [];
    const factory = () => {
      const e = fakeEngine();
      if (engines.length === 0) e.failNext = 1;
      engines.push(e);
      return e;
    };
    const runner = createRunner(factory, fakeSource([game(1), game(2)]));
    const s = await runner.start(Q);
    const final = await waitDone(runner, s.jobId);
    expect(final).toMatchObject({ state: 'done', done: 2 });
    expect(engines).toHaveLength(2);
    expect(engines[0].closed).toBe(1);
    expect(await runner.load(Q)).toHaveLength(2);
  });

  it('marksJobErrorWhenRetryAlsoFails', async () => {
    const engines: ReturnType<typeof fakeEngine>[] = [];
    const factory = () => {
      const e = fakeEngine();
      e.failNext = 1_000;
      engines.push(e);
      return e;
    };
    const runner = createRunner(factory, fakeSource([game(1), game(2)]));
    const s = await runner.start(Q);
    const final = await waitDone(runner, s.jobId);
    expect(final.state).toBe('error');
    expect(final.error).toMatch(/exited unexpectedly/);
    expect(engines).toHaveLength(2);
    expect(final.done).toBe(0);
  });

  it('skipsAFewUnparseableGamesAndKeepsGoing', async () => {
    const games = Array.from({ length: 12 }, (_, i) => game(i + 1));
    games[4] = { ...games[4], pgn: 'this is not a pgn at all 1. zz9' };
    const runner = createRunner(() => fakeEngine(), fakeSource(games));
    const s = await runner.start(Q);
    const final = await waitDone(runner, s.jobId);
    expect(final).toMatchObject({ state: 'done', done: 12, skipped: 1, skippedIds: [games[4].id] });
    expect(final.skipReason).toBeTruthy();
    expect(await runner.load(Q)).toHaveLength(11);
  });

  it('allGamesFailingMarksJobError', async () => {
    const games = [game(1), game(2), game(3)].map((g) => ({ ...g, pgn: 'garbage 1. zz9' }));
    const runner = createRunner(() => fakeEngine(), fakeSource(games));
    const s = await runner.start(Q);
    const final = await waitDone(runner, s.jobId);
    expect(final.state).toBe('error');
    expect(final.error).toMatch(/could not be analysed: /);
    expect(final.skipReason).toBeTruthy();
    expect(final.skippedIds?.length).toBeGreaterThan(0);
  });

  it('moreThanTenPercentSkippedMarksJobError', async () => {
    const games = Array.from({ length: 12 }, (_, i) => game(i + 1));
    games[1] = { ...games[1], pgn: 'bad 1. zz9' };
    games[7] = { ...games[7], pgn: 'bad 1. zz9' };
    const runner = createRunner(() => fakeEngine(), fakeSource(games));
    const final = await waitDone(runner, (await runner.start(Q)).jobId);
    expect(final).toMatchObject({ state: 'error', skipped: 2 });
  });

  it('skippedGamesAreRetriedOnTheNextStart', async () => {
    const games = Array.from({ length: 12 }, (_, i) => game(i + 1));
    const bad = { ...games[4], pgn: 'bad 1. zz9' };
    const src = fakeSource([...games.slice(0, 4), bad, ...games.slice(5)]);
    const runner = createRunner(() => fakeEngine(), src);
    await waitDone(runner, (await runner.start(Q)).jobId);
    const again = await runner.start(Q);
    expect(again.cached).toBe(11); // the skipped one is not cached, so it is attempted again
    await waitDone(runner, again.jobId);
  });

  it('joinsARunningJobWithTheSameQuery', async () => {
    const engine = fakeEngine();
    const runner = createRunner(() => engine, fakeSource([game(1), game(2)]));
    const a = await runner.start(Q);
    const b = await runner.start({ ...Q, usernames: [...Q.usernames] });
    expect(b.jobId).toBe(a.jobId);
    await waitDone(runner, a.jobId);
    const c = await runner.start(Q);
    expect(c.jobId).not.toBe(a.jobId);
  });

  it('loadMakesNoNetworkCallAfterStart', async () => {
    const src = fakeSource([game(1), game(2)]);
    const runner = createRunner(() => fakeEngine(), src);
    await waitDone(runner, (await runner.start(Q)).jobId);
    expect(src.calls).toBe(1);
    expect(await runner.load(Q)).toHaveLength(2);
    expect(await runner.load(Q)).toHaveLength(2);
    expect(src.calls).toBe(1);
  });

  it('loadReturnsFreshGameMetadata', async () => {
    const src = fakeSource([game(1)]);
    const runner = createRunner(() => fakeEngine(), src);
    await waitDone(runner, (await runner.start(Q)).jobId);
    // A later fetch window changes the pre-game rating of the same game.
    src.fetchGames = async () => [{ ...game(1), myPreRating: 1234 }];
    const second = await runner.start(Q);
    await waitDone(runner, second.jobId);
    const [c] = await runner.load(Q);
    expect(c.game.myPreRating).toBe(1234);
    expect(c.analysis.plies.length).toBe(4);
  });

  it('fullyCachedQueryIsDoneImmediately', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowEngine = fakeEngine();
    const slowEval = slowEngine.evaluate;
    slowEngine.evaluate = async () => (await gate, slowEval());
    const src: GameSource = {
      fetchGames: async (users) => (users[0] === 'carol' ? [game(9, 'carol')] : [game(1)]),
    };
    const runner = createRunner(() => slowEngine, src);
    // Seed the cache for query Q with a separate runner, then keep another job busy on a different query.
    const seed = createRunner(() => fakeEngine(), fakeSource([game(1)]));
    await waitDone(seed, (await seed.start(Q)).jobId);
    const other = await runner.start({ ...Q, usernames: ['carol'], maxGames: 7 });
    expect(runner.status(other.jobId).state).toBe('running');
    const cachedStart = await runner.start(Q);
    expect(cachedStart).toMatchObject({ total: 1, cached: 1 });
    expect(runner.status(cachedStart.jobId)).toMatchObject({ state: 'done', done: 1 });
    release();
    await runner.wait(other.jobId);
  });

  it('hungEngineTimesOut', async () => {
    const engines: ReturnType<typeof fakeEngine>[] = [];
    const factory = () => {
      const e = fakeEngine();
      if (engines.length === 0) e.evaluate = () => new Promise<Evaluation>(() => {}); // never answers
      engines.push(e);
      return e;
    };
    const runner = createRunner(factory, fakeSource([game(1), game(2)]), { evaluateTimeoutMs: 30 });
    const final = await waitDone(runner, (await runner.start(Q)).jobId);
    expect(final).toMatchObject({ state: 'done', done: 2 });
    expect(engines).toHaveLength(2);
    expect(engines[0].closed).toBe(1);
  });

  it('hungEngineThatStaysHungMarksJobError', async () => {
    const factory = () => ({ evaluate: () => new Promise<Evaluation>(() => {}), close: async () => {} });
    const runner = createRunner(factory, fakeSource([game(1)]), { evaluateTimeoutMs: 20 });
    const final = await waitDone(runner, (await runner.start(Q)).jobId);
    expect(final.state).toBe('error');
    expect(final.error).toMatch(/hung/);
  });

  it('reports an unknown job as an error', () => {
    const runner = createRunner(() => fakeEngine(), fakeSource([]));
    expect(runner.status('nope')).toMatchObject({ state: 'error' });
  });
});

describe('cache', () => {
  it('cacheKeyDependsOnGameIdAndSettings', () => {
    expect(cacheKey('a')).toBe(cacheKey('a'));
    expect(cacheKey('a')).not.toBe(cacheKey('b'));
    expect(cacheKey('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(ENGINE_CFG.movetimeMs).toBe(30);
  });

  it('writesAtomicallyAndReadsBack', async () => {
    const engine = fakeEngine();
    const analysis = await (await import('../../../src/analysis/analyzeGame')).analyzeGame(PGN, engine, 'g1');
    writeCached({ game: game(1), analysis });
    expect(readCached(game(1).id)?.game.id).toBe(game(1).id);
    const dir = join(coachHome(), 'cache');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dir)).toEqual([`${cacheKey(game(1).id)}.json`]);
  });

  it('treatsMissingOrCorruptFilesAsAMiss', () => {
    expect(readCached('nothing')).toBeNull();
    const dir = join(coachHome(), 'cache');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${cacheKey('bad')}.json`);
    writeFileSync(file, '{"game": ');
    expect(readCached('bad')).toBeNull();
  });
});

describe('parseFreeMemoryPct', () => {
  it('parsesMemoryPressureOutput', () => {
    const out = 'The system has 25769803776 (1572864 pages)\nSystem-wide memory free percentage: 63%\n';
    expect(parseFreeMemoryPct(out)).toBe(63);
    expect(parseFreeMemoryPct('nothing here')).toBeNull();
  });
});


describe('runner concurrency', () => {
  it('joinsEvenWhenTheSecondStartArrivesBeforeTheFirstReturns', async () => {
    const runner = createRunner(() => fakeEngine(), fakeSource([game(1), game(2)]));
    const [a, b] = await Promise.all([runner.start(Q), runner.start(Q)]);
    expect(b.jobId).toBe(a.jobId);
    expect(b.cached).toBe(0);
    await runner.wait(a.jobId);
  });

  it('queuesADifferentQueryBehindTheRunningJob', async () => {
    const engine = fakeEngine();
    const runner = createRunner(() => engine, fakeSource([game(1), game(2)]));
    const a = await runner.start(Q);
    const b = await runner.start({ ...Q, maxGames: 5 });
    expect(b.jobId).not.toBe(a.jobId);
    expect(runner.status(b.jobId).state).toBe('running');
    expect((await runner.wait(b.jobId)).state).toBe('done');
    expect(runner.status(a.jobId).state).toBe('done');
  });
});
