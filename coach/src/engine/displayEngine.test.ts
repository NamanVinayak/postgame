import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Evaluation } from '../../../src/services/engine/types';
import { DISPLAY_CFG } from '../config';
import {
  createDeepStore,
  createDisplayEngine,
  DISPLAY_SETTINGS,
  memoDisplayEngine,
  persistDisplayEngine,
  type SearchMemo,
} from './displayEngine';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ev = (uci: string): Evaluation => ({ cp: 20, mate: null, bestMoveUci: uci, secondBest: null, pvUci: [uci] });

describe('memoDisplayEngine', () => {
  it('searches each position once per memo (move counters ignored), sharing a search already under way', async () => {
    const searched: string[] = [];
    const answers = [ev('e2e4'), ev('d2d4')];
    const engine = createDisplayEngine(() => ({
      async evaluate(fen: string) {
        searched.push(fen);
        return answers[(searched.length - 1) % 2];
      },
    }));
    const memo: SearchMemo = new Map();
    const m = memoDisplayEngine(engine, memo);
    const [a, b] = await Promise.all([m.evaluate(START, 1500), m.evaluate(START, 1500)]);
    const c = await memoDisplayEngine(engine, memo).evaluate(START.replace('0 1', '4 3'), 1500);
    expect(searched).toHaveLength(1);
    expect([a.bestMoveUci, b.bestMoveUci, c.bestMoveUci]).toEqual(['e2e4', 'e2e4', 'e2e4']);
  });

  it('forgets a failed search, so the position can be tried again', async () => {
    let calls = 0;
    const engine = createDisplayEngine(() => ({
      async evaluate() {
        calls++;
        if (calls === 1) throw new Error('Stockfish did not answer within 30 s');
        return ev('e2e4');
      },
    }));
    const m = memoDisplayEngine(engine, new Map());
    await expect(m.evaluate(START, 1500)).rejects.toThrow(/did not answer/);
    await expect(m.evaluate(START, 1500)).resolves.toMatchObject({ bestMoveUci: 'e2e4' });
    expect(calls).toBe(2);
  });
});

describe('display settings', () => {
  it('are deterministic: one thread, a fixed hash and a fixed depth', () => {
    expect(DISPLAY_SETTINGS).toMatchObject({ threads: 1, hashMb: 64, depth: DISPLAY_CFG.depth, multiPv: DISPLAY_CFG.multiPv });
    let seen: unknown = null;
    createDisplayEngine((cfg) => {
      seen = cfg;
      return { evaluate: async () => ev('e2e4') };
    });
    expect(seen).toEqual(DISPLAY_SETTINGS);
  });
});

describe('persistDisplayEngine', () => {
  // A made-up Sicilian position: the same board with two different move counters.
  const POS = 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq -';
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.POSTGAME_COACH_HOME;
    home = mkdtempSync(join(tmpdir(), 'coach-deep-'));
    process.env.POSTGAME_COACH_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.POSTGAME_COACH_HOME;
    else process.env.POSTGAME_COACH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  function counting(answer: Evaluation) {
    const searched: string[] = [];
    const engine = createDisplayEngine(() => ({
      searched,
      async evaluate(fen: string) {
        searched.push(fen);
        return answer;
      },
    }));
    return engine;
  }
  const refusing = () =>
    createDisplayEngine(() => ({
      async evaluate(): Promise<Evaluation> {
        throw new Error('must not search: the answer is on disk');
      },
    }));

  it('persistedResultReusedWithoutSearch', async () => {
    const answer: Evaluation = { cp: 31, mate: null, bestMoveUci: 'a7a6', secondBest: null, pvUci: ['a7a6', 'f1e2'] };
    const first = counting(answer);
    const a = await persistDisplayEngine(first, createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    expect(a).toEqual(answer);
    // The search is made on the position alone (move counters reset), so the stored answer depends only on its key.
    expect(first.searched).toEqual([`${POS} 0 1`]);
    const files = readdirSync(join(home, 'deep'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);

    // A later run (fresh engine, fresh store, same position at other move counters): read from disk, no search.
    const b = await persistDisplayEngine(refusing(), createDeepStore()).evaluate(`${POS} 7 23`, 1500);
    expect(b).toEqual(answer);
  });

  it('a different display setting is a different key, and an unreadable file is searched again', async () => {
    const answer: Evaluation = { cp: 31, mate: null, bestMoveUci: 'a7a6', secondBest: null, pvUci: ['a7a6'] };
    await persistDisplayEngine(counting(answer), createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    const deeper = { ...DISPLAY_SETTINGS, depth: DISPLAY_SETTINGS.depth + 1 };
    await expect(persistDisplayEngine(refusing(), createDeepStore(deeper)).evaluate(`${POS} 0 5`, 1500)).rejects.toThrow(
      /must not search/,
    );

    const [file] = readdirSync(join(home, 'deep'));
    writeFileSync(join(home, 'deep', file), '{ half a file');
    const again = counting(answer);
    await expect(persistDisplayEngine(again, createDeepStore()).evaluate(`${POS} 0 5`, 1500)).resolves.toEqual(answer);
    expect(again.searched).toHaveLength(1);
  });

  it('keeps the wrapped engine’s other methods and leaves no temp files', async () => {
    const native = createDisplayEngine(() => ({
      evaluate: async () => ev('e2e4'),
      positionsSearched: () => 7,
    }));
    const p = persistDisplayEngine(native, createDeepStore());
    expect(p.positionsSearched()).toBe(7);
    await p.evaluate(START, 1500);
    expect(readdirSync(join(home, 'deep')).every((f) => f.endsWith('.json'))).toBe(true);
    expect(existsSync(join(home, 'deep'))).toBe(true);
  });
});
