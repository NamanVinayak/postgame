import { describe, expect, it } from 'vitest';
import type { Evaluation } from '../../../src/services/engine/types';
import { createDisplayEngine, memoDisplayEngine, type SearchMemo } from './displayEngine';

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
