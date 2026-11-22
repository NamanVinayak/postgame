// Unit tests of what the native adapter sends and reports, against fake UCI programs (no Stockfish needed).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFakeFish } from './fakeFish';
import { createNativeStockfish, type NativeStockfish } from './nativeStockfish';

const FEN = 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5';
const FEN2 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-fakefish-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open: NativeStockfish[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()));
});
function make(path: string, opts: Parameters<typeof createNativeStockfish>[0]): NativeStockfish {
  const e = createNativeStockfish({ path, ...opts });
  open.push(e);
  return e;
}
const sent = (log: string) => readFileSync(log, 'utf8').trim().split('\n');

describe('native adapter search commands', () => {
  it('depthModeSendsGoDepth: a fresh game and a fixed depth (with a time cap) before every search', async () => {
    const fake = writeFakeFish(dir, 'depth.sh');
    const engine = make(fake.path, { depth: 16, capMs: 10_000, threads: 1, hashMb: 64, multiPv: 3 });
    const ev = await engine.evaluate(FEN, 1500);
    await engine.evaluate(FEN2, 1500);
    expect(ev).toMatchObject({ cp: 12, bestMoveUci: 'e2e4', pvUci: ['e2e4', 'e7e5'], depth: 16, capped: false });
    const cmds = sent(fake.log);
    expect(cmds).toContain('setoption name Threads value 1');
    expect(cmds).toContain('setoption name Hash value 64');
    expect(cmds).toContain('setoption name MultiPV value 3');
    // Each search: clear the hash (and wait until the engine is ready), set the position, fixed depth.
    const searches = cmds.slice(cmds.indexOf('isready') + 1);
    expect(searches).toEqual([
      'ucinewgame',
      'isready',
      `position fen ${FEN}`,
      'go depth 16 movetime 10000',
      'ucinewgame',
      'isready',
      `position fen ${FEN2}`,
      'go depth 16 movetime 10000',
    ]);
  });

  it('without a depth it keeps the time-limited search and the hash between searches', async () => {
    const fake = writeFakeFish(dir, 'movetime.sh');
    const engine = make(fake.path, { movetimeMs: 30 });
    const ev = await engine.evaluate(FEN, 0);
    const cmds = sent(fake.log);
    expect(cmds).toContain('go movetime 30');
    expect(cmds).not.toContain('ucinewgame');
    expect(cmds.some((c) => c.startsWith('go depth'))).toBe(false);
    expect(ev.capped).toBe(false);
  });

  it('marks a fixed-depth search that stopped short of its depth as capped', async () => {
    const short = writeFakeFish(dir, 'short.sh', { reachDepth: 11 });
    const ev = await make(short.path, { depth: 16, capMs: 10_000 }).evaluate(FEN, 0);
    expect(ev).toMatchObject({ depth: 11, capped: true, bestMoveUci: 'e2e4' });
  });

  it('marks a fixed-depth search that ran into its time cap as capped, even if it reported the depth', async () => {
    const slow = writeFakeFish(dir, 'slow.sh', { sleep: '0.3' });
    const ev = await make(slow.path, { depth: 16, capMs: 200 }).evaluate(FEN, 0);
    expect(ev).toMatchObject({ depth: 16, capped: true });
  });

  it("reports the engine's id name and its own settings", async () => {
    const fake = writeFakeFish(dir, 'id.sh', { idName: 'FakeFish 19' });
    const engine = make(fake.path, { depth: 16, threads: 1, hashMb: 64, multiPv: 3 });
    expect(await engine.engineId()).toBe('FakeFish 19');
    expect(engine.settings()).toMatchObject({ depth: 16, threads: 1, hashMb: 64, multiPv: 3 });
  });
});
