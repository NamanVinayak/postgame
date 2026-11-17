import { describe, expect, test } from 'vitest';
import { analyzeGame } from './analyzeGame';
import type { Engine, Evaluation } from '../services/engine/types';

/**
 * Fake engine returning scripted evals in call order — now one call per
 * *distinct position* (after-position evals are cached and replayed as the
 * next ply's before-position eval by analyzeGame).
 */
class ScriptedEngine implements Engine {
  private queue: Evaluation[];
  calls = 0;
  constructor(evals: Evaluation[]) {
    this.queue = [...evals];
  }
  async evaluate(): Promise<Evaluation> {
    this.calls++;
    return (
      this.queue.shift() ?? {
        cp: 0,
        mate: null,
        bestMoveUci: null,
        secondBest: null,
        pvUci: null,
      }
    );
  }
}

const cp = (v: number): Evaluation => ({
  cp: v,
  mate: null,
  bestMoveUci: null,
  secondBest: null,
  pvUci: null,
});

// 6-ply game; black's move at ply index 3 is scripted as a blunder.
// 6 plies uncover 7 distinct positions, so the script has 7 entries:
// position before ply 3 is black-winning (cp 400, black POV), the position
// after Nc6 is white-better (cp 400, white POV) — same search serves both.
const PGN = '[Event "x"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *';

describe('analyzeGame', () => {
  test('produces one analysis per ply and flags the scripted blunder', async () => {
    const engine = new ScriptedEngine([
      cp(0), // P0: start (white to move)
      cp(0), // P1: after e4 (black POV)
      cp(0), // P2: after e5 (white POV)
      cp(0), // P3: after Nf3 (black POV) — before the blunder, still equal
      cp(400), // P4: after Nc6 (white POV) — same search reused by ply 4
      cp(-400), // P5: after Bb5 (black POV) — white keeps the advantage
      cp(0), // P6: after a6 (white POV)
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

    // Positions are searched once, not once as "before" and again as "after".
    expect(engine.calls).toBe(7);
  });

  test('a clearly best move with a far worse runner-up is a Great move', async () => {
    const engine = new ScriptedEngine([
      {
        cp: 50,
        mate: null,
        bestMoveUci: 'e2e4', // matches the played 1. e4
        secondBest: { cp: -50, mate: null, bestMoveUci: 'd2d4' }, // ~10 win% worse
        pvUci: ['e2e4', 'e7e5', 'g1f3'],
      },
      cp(0),
      cp(0),
      cp(0),
      cp(0),
      cp(0),
      cp(0),
    ]);

    const result = await analyzeGame(PGN, engine, 'game-2');
    expect(result.plies[0].classification).toBe('great');
    expect(result.counts.white.great).toBe(1);
    // The best line is stored in both SAN (display) and UCI (board stepping).
    expect(result.plies[0].bestLineSan).toEqual(['e4', 'e5', 'Nf3']);
    expect(result.plies[0].bestLineUci).toEqual(['e2e4', 'e7e5', 'g1f3']);
  });

  test('a blunder from a winning position is also a missed win', async () => {
    // P3 (before Nc6, black POV) has black clearly winning (cp 400 ≈ 81 win%);
    // after Nc6 white is better instead (cp 400 white POV), so black threw a win.
    const engine = new ScriptedEngine([
      cp(0),
      cp(0),
      cp(0),
      cp(400),
      cp(400),
      cp(-400),
      cp(0),
    ]);

    const result = await analyzeGame(PGN, engine, 'game-3');
    expect(result.plies[3].classification).toBe('blunder');
    expect(result.plies[3].isMissedWin).toBe(true);
    expect(result.plies[3].isMiss).toBe(false);
    expect(result.plies[3].reason).toMatch(/strong move|advantage/i);
    expect(result.missedWins.black).toBe(1);
    expect(result.missedWins.white).toBe(0);
  });

  test('a blunder that lets a clear edge slip is a miss, not a missed win', async () => {
    // P3 (before Nc6, black POV) cp 200 ≈ 68 win% — a clear edge, not a win;
    // after Nc6 white is better (cp 200 white POV), so black missed the edge.
    const engine = new ScriptedEngine([
      cp(0),
      cp(0),
      cp(0),
      cp(200),
      cp(200),
      cp(-200),
      cp(0),
    ]);

    const result = await analyzeGame(PGN, engine, 'game-4');
    expect(result.plies[3].isMiss).toBe(true);
    expect(result.plies[3].isMissedWin).toBe(false);
    expect(result.plies[3].reason).toMatch(/missed a chance/i);
    expect(result.misses.black).toBe(1);
    expect(result.misses.white).toBe(0);
  });

  test('an illegal PV is dropped instead of stored', async () => {
    const engine = new ScriptedEngine([
      { ...cp(0), pvUci: ['e2e4', 'e2e5'] }, // e2e5 is illegal after e4
      cp(0),
      cp(0),
      cp(0),
      cp(0),
      cp(0),
      cp(0),
    ]);
    const result = await analyzeGame(PGN, engine, 'game-5');
    expect(result.plies[0].bestLineSan).toBeNull();
    expect(result.plies[0].bestLineUci).toBeNull();
  });

  test('a best-classified move shows no "better" move', async () => {
    // The engine prefers d4, but e4 loses nothing (same eval) — the
    // difference is search noise, so no "Better: d4" label.
    const engine = new ScriptedEngine([
      { cp: 30, mate: null, bestMoveUci: 'd2d4', secondBest: null, pvUci: ['d2d4'] },
      { cp: -30, mate: null, bestMoveUci: null, secondBest: null, pvUci: null },
      cp(0),
      cp(0),
      cp(0),
      cp(0),
      cp(0),
    ]);
    const result = await analyzeGame(PGN, engine, 'game-6');
    expect(result.plies[0].classification).toBe('best');
    expect(result.plies[0].bestMoveSan).toBeNull();
  });
});
