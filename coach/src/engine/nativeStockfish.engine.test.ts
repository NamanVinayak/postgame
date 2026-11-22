import { afterEach, describe, expect, it } from 'vitest';
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
});
