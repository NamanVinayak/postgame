import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { findRepeated, positionKey } from './repeated';
import { fixtureGame, shuffleSans } from './testGames';

function keyAfter(sans: string[]): string {
  const b = new Chess();
  for (const s of sans) b.move(s);
  return positionKey(b.fen());
}

/** alice (White) reaches the position after `opening`, then plays `reply`, losing `loss` win-% points. */
function game(id: string, opening: string[], reply: string, loss: number, best = 'Nf3') {
  const sans = [...opening, reply, 'Nc6'];
  const wins = sans.map((_, i) => (i >= opening.length ? 50 - loss : 50));
  const bests = sans.map((_, i) => (i === opening.length ? (loss >= 2 ? best : null) : null));
  return fixtureGame({ id, sans, wins, best: bests });
}

describe('findRepeated', () => {
  it('repeatedPositionNeedsThreeSightingsTwoWrong', () => {
    const games = [
      game('A', ['e4', 'e5'], 'Nf3', 0),
      game('B', ['e4', 'e5'], 'Qh5', 8),
      game('C', ['e4', 'e5'], 'Qh5', 8),
      game('D', ['d4', 'd5'], 'Bg5', 8), // seen twice, wrong twice: not enough sightings
      game('E', ['d4', 'd5'], 'Bg5', 8),
    ];
    const found = findRepeated(games);
    expect(found).toHaveLength(1);
    const p = found[0];
    expect(p.key).toBe(keyAfter(['e4', 'e5']));
    expect(p.fen.startsWith(p.key)).toBe(true);
    expect(p.seen).toBe(3);
    expect(p.wrong).toBe(2);
    expect(p.avgLossPts).toBeCloseTo(8, 10); // averaged over the wrong moves
    expect(p.movesFromStart).toEqual(['e4', 'e5']);
    expect(p.best).toBe('Nf3');
    expect(p.usual).toEqual([{ move: 'Qh5', times: 2, lossPts: 8 }]);
    expect([...p.gameIds].sort()).toEqual(['A', 'B', 'C']);
  });

  it('usualListsOnlyWrongMoves', () => {
    // seen 6 times: the engine's move twice, a small slip once, and two different wrong moves
    const games = [
      game('A', ['e4', 'e5'], 'Nf3', 0),
      game('B', ['e4', 'e5'], 'Nf3', 0),
      game('C', ['e4', 'e5'], 'd3', 4), // loses less than 5 points: accepted, never listed
      game('D', ['e4', 'e5'], 'Qh5', 8),
      game('E', ['e4', 'e5'], 'Bc4', 12),
      game('F', ['e4', 'e5'], 'Bc4', 12),
    ];
    const [p] = findRepeated(games);
    expect(p).toMatchObject({ seen: 6, wrong: 3, best: 'Nf3' });
    expect(p.usual).toEqual([
      { move: 'Bc4', times: 2, lossPts: 12 },
      { move: 'Qh5', times: 1, lossPts: 8 },
    ]);
    const listed = p.usual.map((u) => u.move);
    expect(listed).not.toContain(p.best);
    expect(listed).not.toContain('d3');
  });

  it('ignores small losses and the opponent’s moves', () => {
    const small = [1, 2, 3].map((i) => game(`s${i}`, ['e4', 'e5'], 'Qh5', 4)); // below 5 pts: not wrong
    expect(findRepeated(small)).toEqual([]);
    // the opponent (Black) blunders in the same spot three times: not the player's position
    const theirs = [1, 2, 3].map((i) =>
      fixtureGame({ id: `t${i}`, sans: ['c4', 'g5', 'Nc3'], wins: [50, 70, 70] }),
    );
    expect(findRepeated(theirs)).toEqual([]);
  });

  it('counts a position once per game, so one game repeating itself is not a pattern', () => {
    const sans = shuffleSans(12); // the position after 1. Nf3 Nf6 recurs at plies 2, 6 and 10
    const wins = [50, 50, 42, 42, 42, 42, 34, 34, 34, 34, 26, 26];
    expect(findRepeated([fixtureGame({ id: 'loop', sans, wins })])).toEqual([]);
  });

  it('sorts by average loss times wrong count', () => {
    const games = [
      ...[1, 2, 3].map((i) => game(`a${i}`, ['e4', 'e5'], 'Qh5', 8)),
      ...[1, 2, 3].map((i) => game(`b${i}`, ['d4', 'd5'], 'Bg5', 15)),
    ];
    expect(findRepeated(games).map((p) => p.movesFromStart)).toEqual([['d4', 'd5'], ['e4', 'e5']]);
  });
});
