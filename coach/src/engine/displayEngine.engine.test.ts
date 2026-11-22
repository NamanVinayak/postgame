// Real Stockfish: the display search gives the same answer on every fresh run (no disk involved).
import { afterEach, describe, expect, it } from 'vitest';
import type { Evaluation } from '../../../src/services/engine/types';
import { DISPLAY_SETTINGS } from './displayEngine';
import { createNativeStockfish, type NativeStockfish } from './nativeStockfish';

const FENS = [
  // The Sicilian position where two-thread, time-limited searches named Qc7 on one run and a6 on another.
  'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5',
  // A Dragon middlegame and a closed Ruy Lopez middlegame.
  '2rq1rk1/pp1bppbp/3p1np1/4n3/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 13',
  'r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 b - - 0 9',
];

const open: NativeStockfish[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()));
});

/** Each position's answer from one fresh engine process, searching the positions in `order`. */
async function searchAll(order: string[]): Promise<Map<string, Evaluation>> {
  const engine = createNativeStockfish(DISPLAY_SETTINGS);
  open.push(engine);
  const out = new Map<string, Evaluation>();
  for (const fen of order) out.set(fen, await engine.evaluate(fen, 0));
  return out;
}

describe('display search', () => {
  it('sameFenSameAnswerAcrossInstances', async () => {
    // The second instance searches in the opposite order, so a position comes after different
    // earlier searches: the answers can only agree if nothing carries over between searches.
    const [a, b] = await Promise.all([searchAll(FENS), searchAll([...FENS].reverse())]);
    for (const fen of FENS) {
      expect(a.get(fen)?.bestMoveUci).toBeTruthy();
      // Same best move, score, line and second choice: the whole answer, not just the move.
      expect(b.get(fen)).toEqual(a.get(fen));
    }
  });
});
