import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChesscomSource } from './chesscom';
import { parseClocks } from './pgnClocks';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/archive-alice.json', import.meta.url), 'utf8'),
) as { games: any[] };

const API = 'https://api.chess.com/pub/player';

/** Fake Chess.com: each username maps to a list of monthly archives (oldest first). */
function fakeApi(archivesByUser: Record<string, any[][]>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    for (const [user, months] of Object.entries(archivesByUser)) {
      const base = `${API}/${user}/games/archives`;
      if (url === base) {
        const archives = months.map((_, i) => `${API}/${user}/games/2023/${String(i + 1).padStart(2, '0')}`);
        return new Response(JSON.stringify({ archives }), { status: 200 });
      }
      const m = url.match(new RegExp(`^${API}/${user}/games/2023/(\\d+)$`));
      if (m) return new Response(JSON.stringify({ games: months[Number(m[1]) - 1] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const byId = (id: number) => clone(fixture.games.find((g) => g.url.endsWith(`/${id}`)));
const OPTS = { timeClass: 'blitz' as const, maxGames: 300 };

describe('parseClocks', () => {
  it('parsesClkTags', () => {
    const pgn = '[Event "x"]\n\n1. e4 {[%clk 0:02:59.9]} 1... e5 {[%clk 1:00:01]} 2. Nf3 {[%clk 0:00:05.25]} *';
    const clocks = parseClocks(pgn);
    expect(clocks).toHaveLength(3);
    expect(clocks[0]).toBeCloseTo(179.9, 5);
    expect(clocks[1]).toBe(3601);
    expect(clocks[2]).toBeCloseTo(5.25, 5);
  });

  it('missingClocksYieldNulls', () => {
    const pgn = '[Event "x"]\n[White "alice"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0';
    expect(parseClocks(pgn)).toEqual([null, null, null, null, null]);
  });

  it('handlesGlueAndResultTokens', () => {
    expect(parseClocks('1.e4 {[%clk 0:01:00]} e5 {[%clk 0:00:59]} 2.Nf3 1/2-1/2')).toEqual([60, 59, null]);
  });
});

describe('createChesscomSource', () => {
  let dir: string;
  const prev = process.env.POSTGAME_COACH_HOME;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postgame-coach-src-'));
    process.env.POSTGAME_COACH_HOME = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.POSTGAME_COACH_HOME;
    else process.env.POSTGAME_COACH_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('preRatingFromPreviousGame', async () => {
    const { fetchImpl } = fakeApi({ alice: [fixture.games] });
    const games = await createChesscomSource(fetchImpl).fetchGames(['alice'], OPTS);
    // blitz, rated, chess only; the rapid game (1900) must not leak into the chain
    expect(games.map((g) => g.url.split('/').pop())).toEqual(['9001', '9003', '9004']);
    expect(games[0].myPreRating).toBeNull();
    expect(games[1].myPreRating).toBe(games[0].myRating);
    expect(games[2].myPreRating).toBe(games[1].myRating);
    expect(games[1].myPreRating).toBe(1500);
    expect(games[0]).toMatchObject({ username: 'alice', timeControl: '180+2', baseSec: 180, incSec: 2 });
    expect(games[0].clocks).toHaveLength(6);
    expect(games[0].clocks[0]).toBe(180);
    expect(games[0].clocks[3]).toBeCloseTo(177.2, 5);
  });

  it('dropsGamesOutsideRatingWindow', async () => {
    // 9008: opponent 1748 vs previous game's rating 1498 = 250 away -> dropped
    const { fetchImpl } = fakeApi({ alice: [fixture.games] });
    const games = await createChesscomSource(fetchImpl).fetchGames(['alice'], OPTS);
    expect(games.some((g) => g.url.endsWith('/9008'))).toBe(false);

    // myPreRating null (first game): compare with myRating (1500)
    for (const [oppRating, kept] of [[1650, true], [1750, false]] as const) {
      const first = byId(9001);
      first.black.rating = oppRating;
      const api = fakeApi({ alice: [[first]] });
      const out = await createChesscomSource(api.fetchImpl).fetchGames(['alice'], OPTS);
      expect(out.length === 1).toBe(kept);
    }
  });

  it('usesPreRatingNotCurrentRatingForTheWindow', async () => {
    // current rating 1700 but pre-game rating 1500 and opponent 1690: 190 from pre -> kept
    const a = byId(9001);
    const b = byId(9004);
    b.white.rating = 1700;
    b.black.rating = 1690;
    const { fetchImpl } = fakeApi({ alice: [[a, b]] });
    const out = await createChesscomSource(fetchImpl).fetchGames(['alice'], OPTS);
    expect(out.map((g) => g.url.split('/').pop())).toEqual(['9001', '9004']);
  });

  it('respectsExcludeAccounts', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ excludeAccounts: ['BOB'] }));
    const bobGame = byId(9001);
    bobGame.white.username = 'bob';
    bobGame.black.username = 'carol';
    bobGame.url = 'https://www.chess.com/game/live/9101';
    const { fetchImpl, calls } = fakeApi({ alice: [fixture.games], bob: [[bobGame]] });
    const games = await createChesscomSource(fetchImpl).fetchGames(['Alice', 'bob'], OPTS);
    expect(new Set(games.map((g) => g.username))).toEqual(new Set(['Alice']));
    expect(calls.some((c) => c.url.includes('/bob/'))).toBe(false);
  });

  it('sortsOldestFirstAcrossAccountsAndSendsUserAgent', async () => {
    const other = byId(9001);
    other.white.username = 'alice2';
    other.url = 'https://www.chess.com/game/live/9201';
    other.end_time = 1699999000;
    const { fetchImpl, calls } = fakeApi({ alice: [fixture.games], alice2: [[other]] });
    const games = await createChesscomSource(fetchImpl).fetchGames(['alice', 'alice2'], OPTS);
    const times = games.map((g) => g.endTime);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(games[0].username).toBe('alice2');
    for (const c of calls) {
      expect(c.headers['User-Agent']).toBe('postgame-coach (+https://github.com/NamanVinayak/postgame)');
    }
  });

  it('walksNewestFirstAndStopsAtMaxGames', async () => {
    const mk = (id: number, t: number) => {
      const g = byId(9001);
      g.url = `https://www.chess.com/game/live/${id}`;
      g.end_time = t;
      g.black.rating = 1500;
      return g;
    };
    const months = [[mk(1, 100), mk(2, 200)], [mk(3, 300), mk(4, 400)], [mk(5, 500), mk(6, 600)]];
    const { fetchImpl, calls } = fakeApi({ alice: months });
    const games = await createChesscomSource(fetchImpl).fetchGames(['alice'], { ...OPTS, maxGames: 2 });
    expect(games.map((g) => g.endTime)).toEqual([500, 600]);
    expect(calls.some((c) => c.url.endsWith('/2023/01'))).toBe(false);
    expect(games[0].myPreRating).toBe(1500); // needed one older game to know it
  });

  it('honoursBefore', async () => {
    const { fetchImpl } = fakeApi({ alice: [fixture.games] });
    const games = await createChesscomSource(fetchImpl).fetchGames(['alice'], { ...OPTS, before: 1700004000 });
    expect(games.map((g) => g.url.split('/').pop())).toEqual(['9001', '9003']);
  });

  it('handlesDailyGamesWithoutClocks', async () => {
    const { fetchImpl } = fakeApi({ alice: [fixture.games] });
    const games = await createChesscomSource(fetchImpl).fetchGames(['alice'], { timeClass: 'daily', maxGames: 10 });
    expect(games).toHaveLength(1);
    expect(games[0].timeControl).toBe('1/259200');
    expect(games[0].baseSec).toBe(0);
    expect(games[0].incSec).toBe(0);
    expect(games[0].clocks.every((c) => c === null)).toBe(true);
  });

  it('runsRequestsOneAtATime', async () => {
    let inFlight = 0;
    let peak = 0;
    const api = fakeApi({ alice: [fixture.games], bob: [[]] });
    const wrapped = (async (...a: Parameters<typeof fetch>) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try { return await api.fetchImpl(...a); } finally { inFlight--; }
    }) as typeof fetch;
    await createChesscomSource(wrapped).fetchGames(['alice', 'bob'], OPTS);
    expect(peak).toBe(1);
  });
});
