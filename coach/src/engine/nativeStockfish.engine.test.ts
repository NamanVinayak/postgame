import { afterEach, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNativeStockfish } from './nativeStockfish';

type Native = ReturnType<typeof createNativeStockfish>;
const open: Native[] = [];
function make(opts?: Parameters<typeof createNativeStockfish>[0]): Native {
  const e = createNativeStockfish(opts);
  open.push(e);
  return e;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()));
});

describe('createNativeStockfish', () => {
  it('findsMateInOne', async () => {
    const engine = make();
    const ev = await engine.evaluate('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 0);
    expect(ev.bestMoveUci).toBe('a1a8');
    expect(ev.mate).toBe(1);
    expect(ev.cp).toBeNull();
  });

  it('startPositionRoughlyEqual', async () => {
    const engine = make();
    const ev = await engine.evaluate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 0);
    expect(Math.abs(ev.cp ?? 9999)).toBeLessThan(60);
    expect(ev.pvUci?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(ev.secondBest).not.toBeNull();
    expect(ev.secondBest?.bestMoveUci).toBeTruthy();
  });

  it('serializes concurrent searches and counts positions', async () => {
    const engine = make();
    const fens = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ];
    const evs = await Promise.all(fens.map((f) => engine.evaluate(f, 0)));
    expect(evs[1].bestMoveUci).toBe('a1a8');
    expect(evs.every((e) => e.bestMoveUci !== null)).toBe(true);
    expect(engine.positionsSearched()).toBe(3);
  });

  it('reports a checkmated position without a move', async () => {
    const engine = make();
    const ev = await engine.evaluate('R5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1', 0);
    expect(ev.bestMoveUci).toBeNull();
  });

  it('throws a helpful error when the binary is missing', async () => {
    const engine = make({ path: '/nonexistent/stockfish' });
    await expect(engine.evaluate('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 0)).rejects.toThrow(
      'Stockfish not found at /nonexistent/stockfish. Install it with: brew install stockfish',
    );
  });

  const FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Fails the test if `p` has not settled within `ms` (guards against hangs). */
  const within = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`hung > ${ms} ms`)))]);

  it('rejectsAfterProcessDies', async () => {
    const engine = make();
    await engine.evaluate(FEN, 0);
    const pid = engine.pid();
    expect(pid).not.toBeNull();
    process.kill(pid!, 'SIGKILL');
    await sleep(100);
    await expect(within(engine.evaluate(FEN, 0), 3000)).rejects.toThrow(/exited unexpectedly/);
    // and keeps rejecting instead of hanging
    await expect(within(engine.evaluate(FEN, 0), 3000)).rejects.toThrow(/exited unexpectedly/);
  });

  it('rejectsWhenProcessDiesMidSearch', async () => {
    const engine = make({ movetimeMs: 5000 });
    const pending = engine.evaluate(FEN, 0);
    pending.catch(() => undefined);
    await sleep(500);
    process.kill(engine.pid()!, 'SIGKILL');
    await expect(within(pending, 3000)).rejects.toThrow(/exited unexpectedly/);
  });

  it('closeDuringSearchRejects', async () => {
    const engine = make({ movetimeMs: 5000 });
    const pending = engine.evaluate(FEN, 0);
    const queued = engine.evaluate(FEN, 0);
    pending.catch(() => undefined);
    queued.catch(() => undefined);
    await sleep(500); // search is in flight
    const pid = engine.pid()!;
    await within(engine.close(), 5000);
    await expect(within(pending, 3000)).rejects.toThrow(/closed/);
    await expect(within(queued, 3000)).rejects.toThrow(/closed/);
    expect(isAlive(pid)).toBe(false);
    await expect(within(engine.evaluate(FEN, 0), 3000)).rejects.toThrow(/closed/);
  });

  it('closeRacingFirstSpawnLeavesNoOrphan', async () => {
    // close() while the first spawn/handshake is still in progress
    const engine = make();
    const pending = engine.evaluate(FEN, 0);
    pending.catch(() => undefined);
    await sleep(1);
    const pid = engine.pid();
    await within(engine.close(), 5000);
    if (pid !== null) expect(isAlive(pid)).toBe(false);
    await expect(within(pending, 3000)).rejects.toThrow();
    await sleep(300);
    if (pid !== null) expect(isAlive(pid)).toBe(false);
    expect(engine.pid()).toBeNull();

    // close() immediately after evaluate(), before the spawn is even scheduled
    const engine2 = make();
    const pending2 = engine2.evaluate(FEN, 0);
    pending2.catch(() => undefined);
    await engine2.close();
    await expect(within(pending2, 3000)).rejects.toThrow(/closed/);
    await sleep(300);
    expect(engine2.pid()).toBeNull();
  });
});
