import { describe, expect, test } from 'vitest';
import { analyzeGame } from './analyzeGame';
import type { Engine, Evaluation } from '../services/engine/types';

/** Fake engine returning scripted evals in call order (before, after per ply). */
class ScriptedEngine implements Engine {
  private queue: Evaluation[];
  constructor(evals: Evaluation[]) {
    this.queue = [...evals];
  }
  async evaluate(): Promise<Evaluation> {
    return this.queue.shift() ?? { cp: 0, mate: null, bestMoveUci: null };
  }
}

const cp = (v: number): Evaluation => ({ cp: v, mate: null, bestMoveUci: null });

// 6-ply game; black's move at ply index 3 is scripted as a blunder.
const PGN = '[Event "x"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *';

describe('analyzeGame', () => {
  test('produces one analysis per ply and flags the scripted blunder', async () => {
    const engine = new ScriptedEngine([
      cp(0), cp(0), // ply 0 (white) before, after
      cp(0), cp(0), // ply 1 (black)
      cp(0), cp(0), // ply 2 (white)
      cp(400), cp(400), // ply 3 (black) — blunder: was winning, opponent now winning
      cp(0), cp(0), // ply 4 (white)
      cp(0), cp(0), // ply 5 (black)
    ]);

    const progress: Array<[number, number]> = [];
    const result = await analyzeGame(PGN, engine, 'game-1', (d, t) => progress.push([d, t]));

    expect(result.plies).toHaveLength(6);
    expect(result.plies[3].classification).toBe('blunder');
    expect(result.plies[3].color).toBe('black');
    expect(result.plies[3].reason).not.toBeNull();

    expect(result.whiteAccuracy).toBeGreaterThan(95);
    expect(result.blackAccuracy).toBeLessThan(result.whiteAccuracy);
    expect(result.whiteAccuracy).toBeLessThanOrEqual(100);
    expect(result.blackAccuracy).toBeGreaterThanOrEqual(0);

    expect(result.counts.black.blunder).toBe(1);
    expect(result.gameId).toBe('game-1');
    expect(progress.at(-1)).toEqual([6, 6]);
  });
});
