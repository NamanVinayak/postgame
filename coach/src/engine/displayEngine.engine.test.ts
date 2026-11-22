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

async function searchAll(): Promise<Evaluation[]> {
  const engine = createNativeStockfish(DISPLAY_SETTINGS); // a fresh process: nothing carried over
  open.push(engine);
  const out: Evaluation[] = [];
  for (const fen of FENS) out.push(await engine.evaluate(fen, 0));
  return out;
}

describe('display search', () => {
  it('sameFenSameAnswerAcrossInstances', async () => {
    const [a, b] = await Promise.all([searchAll(), searchAll()]);
    for (let i = 0; i < FENS.length; i++) {
      expect(a[i].bestMoveUci).toBeTruthy();
      // Same best move, score, line and second choice: the whole answer, not just the move.
      expect(b[i]).toEqual(a[i]);
    }
  });
});
