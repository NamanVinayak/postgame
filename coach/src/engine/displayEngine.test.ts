import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Evaluation } from '../../../src/services/engine/types';
import { DISPLAY_CFG } from '../config';
import {
  createDeepStore,
  createDisplayEngine,
  DISPLAY_SETTINGS,
  memoDisplayEngine,
  normaliseFen,
  persistDisplayEngine,
  type SearchMemo,
} from './displayEngine';
import { writeFakeFish } from './fakeFish';
import { createNativeStockfish, type NativeStockfish } from './nativeStockfish';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ev = (uci: string): Evaluation => ({ cp: 20, mate: null, bestMoveUci: uci, secondBest: null, pvUci: [uci] });

// After 1.e4: the FEN may or may not name e3, but no black pawn can take there.
const AFTER_E4_EP = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const AFTER_E4_NO_EP = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

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
    // Other move counters, and another (ignored) time budget: still the same search.
    const c = await memoDisplayEngine(engine, memo).evaluate(START.replace('0 1', '4 3'), 30);
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

describe('normaliseFen', () => {
  it('sameBoardDifferentEpFieldSameKey', async () => {
    // No pawn can take en passant: the field is dropped, so both spellings are one position.
    expect(normaliseFen(AFTER_E4_EP)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
    expect(normaliseFen(AFTER_E4_EP)).toBe(normaliseFen(AFTER_E4_NO_EP));
    // A legal en-passant capture exists (…dxe3): the field stays, it is a different position.
    expect(normaliseFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3')).toBe(
      'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3',
    );
    // The capture is possible but illegal (it would leave the black king on a4 open to the rook): dropped.
    expect(normaliseFen('8/8/8/8/k2pP2R/8/8/4K3 b - e3 0 1')).toBe('8/8/8/8/k2pP2R/8/8/4K3 b - -');

    // The session memo shares one search between the two spellings.
    const searched: string[] = [];
    const engine = createDisplayEngine(() => ({
      async evaluate(fen: string) {
        searched.push(fen);
        return ev('e7e5');
      },
    }));
    const m = memoDisplayEngine(engine, new Map());
    await m.evaluate(AFTER_E4_EP, 1500);
    await m.evaluate(AFTER_E4_NO_EP, 1500);
    expect(searched).toHaveLength(1);
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
  afterEach(async () => {
    await Promise.all(open.splice(0).map((e) => e.close()));
    if (prevHome === undefined) delete process.env.POSTGAME_COACH_HOME;
    else process.env.POSTGAME_COACH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });
  const stored = () => readdirSync(join(home, 'deep'));

  /** A complete depth-N answer, as the native adapter reports it. */
  const answer = { cp: 31, mate: null, bestMoveUci: 'a7a6', secondBest: null, pvUci: ['a7a6', 'f1e2'], depth: 16, capped: false };

  /** A fake display engine with an id and its own settings, counting searches. */
  function counting(result: Evaluation & { capped?: boolean } = answer, id = 'FakeFish 1', settings = DISPLAY_SETTINGS) {
    const searched: string[] = [];
    const engine = createDisplayEngine(() => ({
      searched,
      engineId: async () => id,
      settings: () => settings,
      async evaluate(fen: string) {
        searched.push(fen);
        return result;
      },
    }));
    return engine;
  }
  const refusing = (id = 'FakeFish 1') =>
    createDisplayEngine(() => ({
      engineId: async () => id,
      settings: () => DISPLAY_SETTINGS,
      async evaluate(): Promise<Evaluation> {
        throw new Error('must not search: the answer is on disk');
      },
    }));

  const open: NativeStockfish[] = [];
  /** The native adapter on a fake UCI program, as a display engine. */
  function nativeFake(name: string, o: Parameters<typeof writeFakeFish>[2], settings = {}) {
    const fake = writeFakeFish(home, name, o);
    const engine = createDisplayEngine(() => createNativeStockfish({ ...DISPLAY_SETTINGS, ...settings, path: fake.path }));
    open.push(engine);
    return engine;
  }

  it('persistedResultReusedWithoutSearch', async () => {
    const first = counting();
    const a = await persistDisplayEngine(first, createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    expect(a).toEqual(answer);
    // The search is made on the position alone (move counters reset), so the stored answer depends only on its key.
    expect(first.searched).toEqual([`${POS} 0 1`]);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatch(/^[0-9a-f]{64}\.json$/);

    // A later run (fresh engine, fresh store, same position at other move counters): read from disk, no search.
    const b = await persistDisplayEngine(refusing(), createDeepStore()).evaluate(`${POS} 7 23`, 1500);
    expect(b).toEqual(answer);
  });

  it('the key comes from the engine itself: another Stockfish build or other settings never reuse an answer', async () => {
    await persistDisplayEngine(counting(), createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    // Another `id name` (e.g. after an upgrade): searched again, stored separately.
    const upgraded = counting(answer, 'FakeFish 2');
    await persistDisplayEngine(upgraded, createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    expect(upgraded.searched).toHaveLength(1);
    // Another depth in the engine's own settings: searched again too.
    const deeper = counting(answer, 'FakeFish 1', { ...DISPLAY_SETTINGS, depth: DISPLAY_SETTINGS.depth + 1 });
    await persistDisplayEngine(deeper, createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    expect(deeper.searched).toHaveLength(1);
    expect(stored()).toHaveLength(3);
    // The original engine still reads its own file.
    await expect(persistDisplayEngine(refusing(), createDeepStore()).evaluate(`${POS} 0 5`, 1500)).resolves.toEqual(answer);
  });

  it('reads the id name from the real adapter (on a fake UCI program) before using the disk', async () => {
    const a = nativeFake('fish-a.sh', { idName: 'FakeFish A' });
    await persistDisplayEngine(a, createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    const b = nativeFake('fish-b.sh', { idName: 'FakeFish B' });
    await persistDisplayEngine(b, createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    expect(a.positionsSearched()).toBe(1);
    expect(b.positionsSearched()).toBe(1); // a different id name is a different key
    const a2 = nativeFake('fish-a2.sh', { idName: 'FakeFish A' });
    await persistDisplayEngine(a2, createDeepStore()).evaluate(`${POS} 3 9`, 1500);
    expect(a2.positionsSearched()).toBe(0); // same id name: answered from disk
  });

  it('cappedResultNotPersisted', async () => {
    // The search stopped at depth 11 of 16 (its time cap): shown, but never stored.
    const short = nativeFake('short.sh', { reachDepth: 11 });
    const p = persistDisplayEngine(short, createDeepStore());
    const r = await p.evaluate(`${POS} 0 5`, 1500);
    expect(r).toMatchObject({ bestMoveUci: 'e2e4', depth: 11, capped: true });
    expect(readdirSync(home).includes('deep') ? stored() : []).toHaveLength(0);
    // So the next run searches again instead of serving the capped answer as the depth-16 one.
    await p.evaluate(`${POS} 0 5`, 1500);
    expect(short.positionsSearched()).toBe(2);
    // A result that says nothing about reaching its depth is not stored either.
    await persistDisplayEngine(counting(ev('e2e4')), createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    expect(readdirSync(home).includes('deep') ? stored() : []).toHaveLength(0);
  });

  it('a corrupt file is searched again, and no temp files are left', async () => {
    await persistDisplayEngine(counting(), createDeepStore()).evaluate(`${POS} 0 5`, 1500);
    writeFileSync(join(home, 'deep', stored()[0]), '{ half a file');
    const again = counting();
    await expect(persistDisplayEngine(again, createDeepStore()).evaluate(`${POS} 0 5`, 1500)).resolves.toEqual(answer);
    expect(again.searched).toHaveLength(1);
    expect(stored().every((f) => f.endsWith('.json'))).toBe(true);
  });

  it('refuses to store an engine that is not a fixed-depth search', async () => {
    const timed = counting(answer, 'FakeFish 1', { ...DISPLAY_SETTINGS, depth: undefined as unknown as number });
    await expect(persistDisplayEngine(timed, createDeepStore()).evaluate(`${POS} 0 5`, 1500)).rejects.toThrow(/fixed-depth/);
  });

  it('keeps the wrapped engine’s other methods', () => {
    const native = createDisplayEngine(() => ({
      evaluate: async () => ev('e2e4'),
      engineId: async () => 'FakeFish 1',
      settings: () => DISPLAY_SETTINGS,
      positionsSearched: () => 7,
    }));
    expect(persistDisplayEngine(native, createDeepStore()).positionsSearched()).toBe(7);
  });
});
