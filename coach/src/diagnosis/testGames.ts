// Synthetic games for the diagnosis tests. Made-up players only; no engine, no network.
import { Chess } from 'chess.js';
import { DELTA } from '../../../src/constants';
import type { AnalysisResult, Classification, Color, PlyAnalysis, TimeClass } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import type { CoachGame } from '../sources/types';

/** Small seeded generator for fixtures (independent of the code under test). */
export function testRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Picks exactly `count` of `slots` positions at random (seeded); true marks a picked slot. */
export function scatter(count: number, slots: number, rng: () => number): boolean[] {
  const idx = Array.from({ length: slots }, (_, i) => i);
  for (let i = slots - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const out = new Array<boolean>(slots).fill(false);
  for (let k = 0; k < count; k++) out[idx[k]] = true;
  return out;
}

/** Knights hopping out and back: full material, no captures, so every ply after move 10 is middlegame. */
export function shuffleSans(plies: number): string[] {
  const cycle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
  return Array.from({ length: plies }, (_, i) => cycle[i % 4]);
}

/** A random legal game (seeded), for timing on positions with realistic branching. */
export function randomSans(seed: number, plies: number): string[] {
  const rng = testRng(seed);
  const board = new Chess();
  const out: string[] = [];
  while (out.length < plies && !board.isGameOver()) {
    const moves = board.moves();
    const san = moves[Math.floor(rng() * moves.length)];
    board.move(san);
    out.push(san);
  }
  return out;
}

function classify(loss: number): Classification {
  if (loss >= DELTA.blunder) return 'blunder';
  if (loss >= DELTA.mistake) return 'mistake';
  if (loss >= DELTA.inaccuracy) return 'inaccuracy';
  if (loss >= DELTA.good) return 'good';
  return 'best';
}

export interface FixtureOpts {
  id: string;
  sans: string[];
  myColor?: Color;
  /** White's win % after each ply (default 50 throughout). */
  wins?: number[];
  /** Override the classification of a ply (default: from the mover's win-% loss, by DELTA). */
  cls?: (Classification | undefined)[];
  /** Engine's best move before each ply (default: null when the move lost < 2 pts, else 'Nc3'). */
  best?: (string | null | undefined)[];
  /** Seconds left after each ply (default: 170 s for every ply). */
  clocks?: (number | null)[];
  baseSec?: number;
  incSec?: number;
  timeClass?: TimeClass;
  endTime?: number;
  username?: string;
}

/** A cached game whose analysis is built from the given win % and classifications. */
export function fixtureGame(o: FixtureOpts): CachedGame {
  const myColor = o.myColor ?? 'white';
  const wins = o.wins ?? o.sans.map(() => 50);
  const plies: PlyAnalysis[] = o.sans.map((san, i) => {
    const color: Color = i % 2 === 0 ? 'white' : 'black';
    const beforeW = i === 0 ? 50 : wins[i - 1];
    const before = color === 'white' ? beforeW : 100 - beforeW;
    const after = color === 'white' ? wins[i] : 100 - wins[i];
    const loss = Math.max(0, before - after);
    const classification = o.cls?.[i] ?? classify(loss);
    const best = o.best?.[i] !== undefined ? (o.best[i] as string | null) : loss < DELTA.good ? null : 'Nc3';
    return {
      ply: i,
      moveSan: san,
      color,
      evalCp: 0,
      mate: null,
      winPctWhite: wins[i],
      classification,
      isMissedWin: false,
      isMiss: false,
      bestMoveSan: best,
      bestLineSan: best ? [best] : null,
      bestLineUci: null,
      reason: null,
      accuracy: 100,
    };
  });
  const game: CoachGame = {
    id: o.id,
    url: o.id,
    timeClass: o.timeClass ?? 'blitz',
    endTime: o.endTime ?? 1_700_000_000,
    rated: true,
    myColor,
    outcome: 'draw',
    opponent: { username: 'bob', rating: 1500 },
    myRating: 1500,
    pgn: '[Event "x"]\n\n*',
    username: o.username ?? 'alice',
    timeControl: `${o.baseSec ?? 180}+${o.incSec ?? 0}`,
    baseSec: o.baseSec ?? 180,
    incSec: o.incSec ?? 0,
    myPreRating: 1500,
    clocks: o.clocks ?? o.sans.map(() => 170),
  };
  const empty = (): Record<Classification, number> => ({ great: 0, best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 });
  const analysis: AnalysisResult = {
    gameId: o.id,
    schemaVersion: 7,
    plies,
    whiteAccuracy: 90,
    blackAccuracy: 90,
    counts: { white: empty(), black: empty() },
    missedWins: { white: 0, black: 0 },
    misses: { white: 0, black: 0 },
    createdAt: 0,
  };
  return { game, analysis };
}

/**
 * `games` knight-shuffle games of 80 plies, alice as White. Plies 20–79 are middlegame:
 * 30 moves per side per game. `myErrors` / `oppErrors` serious mistakes are scattered at random
 * (seeded) over all of each side's middlegame moves, so games differ the way real ones do.
 */
export function middlegameSet(games: number, myErrors: number, oppErrors: number, seed: number): CachedGame[] {
  const rng = testRng(seed);
  const perSide = 30;
  const mine = scatter(myErrors, games * perSide, rng);
  const theirs = scatter(oppErrors, games * perSide, rng);
  const sans = shuffleSans(80);
  return Array.from({ length: games }, (_, g) => {
    const cls: (Classification | undefined)[] = sans.map(() => undefined);
    for (let k = 0; k < perSide; k++) {
      if (mine[g * perSide + k]) cls[20 + 2 * k] = 'mistake';
      if (theirs[g * perSide + k]) cls[21 + 2 * k] = 'blunder';
    }
    return fixtureGame({ id: `https://example.test/game/${seed}-${g}`, sans, cls, endTime: 1_700_000_000 + g });
  });
}
