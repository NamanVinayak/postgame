import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { areasOfPly, gamePlies } from './areas';
import { fixtureGame } from './testGames';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_7 = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R b KQkq - 0 8';
const ROOKS = 'r3k3/8/8/8/8/8/8/4K2R w - - 0 40';
const BLITZ = fixtureGame({ id: 'g', sans: ['e4'], baseSec: 180, incSec: 0 }).game;
const RAPID = { ...BLITZ, baseSec: 600, timeControl: '600' };
const DAILY = { ...BLITZ, baseSec: 0, timeClass: 'daily' as const, timeControl: '1/259200' };

describe('areasOfPly', () => {
  it('areasOfPlyCutoffs', () => {
    expect(areasOfPly(AFTER_7, 15, 50, 150, BLITZ)).toEqual(['opening']); // move 8
    expect(areasOfPly(ROOKS, 79, 50, 150, BLITZ)).toEqual(['endgame']); // K+R vs K+R
    expect(areasOfPly(START, 30, 80, 150, BLITZ)).toContain('converting');
    expect(areasOfPly(START, 30, 20, 150, BLITZ)).toContain('defending');
    expect(areasOfPly(START, 30, 50, 20, BLITZ)).toContain('timePressure'); // 20 s left in 180+0
  });

  it('places phase and thresholds exactly at the documented edges', () => {
    expect(areasOfPly(START, 19, 50, 150, BLITZ)).toEqual(['opening']); // move 10
    expect(areasOfPly(START, 20, 50, 150, BLITZ)).toEqual(['middlegame']); // move 11
    expect(areasOfPly(ROOKS, 4, 50, 150, BLITZ)).toEqual(['endgame']); // material beats move number
    expect(areasOfPly(START, 30, 75, 150, BLITZ)).toEqual(['middlegame', 'converting']);
    expect(areasOfPly(START, 30, 74.9, 150, BLITZ)).toEqual(['middlegame']);
    expect(areasOfPly(START, 30, 25, 150, BLITZ)).toEqual(['middlegame', 'defending']);
    expect(areasOfPly(START, 30, 50, 30, BLITZ)).toEqual(['middlegame']); // not < 30 s
    expect(areasOfPly(START, 30, 50, 45, RAPID)).toContain('timePressure'); // 10% of 600 s = 60 s
    expect(areasOfPly(START, 30, 50, null, BLITZ)).toEqual(['middlegame']);
    expect(areasOfPly(START, 30, 50, 0, DAILY)).toEqual(['middlegame']); // daily: no clock
  });
});

describe('gamePlies', () => {
  // Castling both ways, en passant, a promotion and a check.
  const LINE = ['e4', 'd5', 'e5', 'f5', 'exf6', 'Nc6', 'fxg7', 'Bf5', 'gxh8=Q', 'Qd7', 'Nf3', 'O-O-O', 'Bb5', 'a6',
    'O-O', 'axb5', 'Qxg8', 'Kb8', 'Qxf8', 'Rxf8', 'd4', 'Qe6', 'Re1', 'Qxe1+', 'Nxe1', 'Rf7'];

  it('replays every ply to the same positions as chess.js move()', () => {
    const board = new Chess();
    const expected = LINE.map((san) => board.move(san).before);
    const facts = gamePlies(fixtureGame({ id: 'line', sans: LINE }));
    expect(facts?.map((f) => f.fenBefore)).toEqual(expected);
  });

  it('wires win % and clocks from the previous plies, from the mover’s side', () => {
    const c = fixtureGame({
      id: 'w',
      sans: ['e4', 'e5', 'Nf3', 'Nc6'],
      myColor: 'black',
      wins: [60, 70, 80, 90], // White's win % after each ply
      clocks: [178, 25, 177, 20],
      baseSec: 180,
    });
    const f = gamePlies(c)!;
    expect(f.map((p) => p.winBeforeMover)).toEqual([50, 40, 70, 20]);
    expect(f.map((p) => p.lossPts)).toEqual([0, 10, 0, 10]);
    expect(f.map((p) => p.mine)).toEqual([false, true, false, true]);
    // ply 3 (Black's 2nd move) uses Black's clock after ply 1 (25 s < 30 s); first moves use the base time
    expect(f[3].areas).toContain('timePressure');
    expect(f[1].areas).not.toContain('timePressure');
    expect(f[3].areas).toContain('defending');
  });

  it('returns null for a game whose moves cannot be replayed', () => {
    expect(gamePlies(fixtureGame({ id: 'bad', sans: ['e4', 'e4'] }))).toBeNull();
  });
});
