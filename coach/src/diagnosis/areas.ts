import { Chess } from 'chess.js';
import type { Color } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { AREA_CFG } from '../config';
import type { CoachGame } from '../sources/types';

/**
 * The six areas a move can be filed under. A move is in exactly one phase (opening,
 * middlegame or endgame) and, independently, may also be converting or defending, and
 * may also be under time pressure. Cutoffs live in AREA_CFG.
 */
export type AreaKey = 'opening' | 'middlegame' | 'endgame' | 'converting' | 'defending' | 'timePressure';
export const AREA_KEYS: AreaKey[] = ['opening', 'middlegame', 'endgame', 'converting', 'defending', 'timePressure'];

/** Plain-English names for each area, for text a player reads. */
export const AREA_NAMES: Record<AreaKey, string> = {
  opening: `the opening (moves 1–${AREA_CFG.openingLastMove})`,
  middlegame: 'the middlegame',
  endgame: 'the endgame',
  converting: 'converting a winning position',
  defending: 'defending a worse position',
  timePressure: 'moves under time pressure',
};

const PIECE_VALUE: Record<string, number> = { q: 9, r: 5, b: 3, n: 3 };

/** Queens, rooks, bishops and knights of both sides (9/5/3/3), read from a FEN's board field. */
export function nonPawnMaterial(fen: string): number {
  let total = 0;
  for (const ch of fen) {
    if (ch === ' ') break;
    total += PIECE_VALUE[ch.toLowerCase()] ?? 0;
  }
  return total;
}

/**
 * The areas a move falls in, from the mover's point of view.
 * - Phase: endgame when non-pawn material ≤ AREA_CFG.endgameMaxNonPawn (material decides even
 *   early on); else opening while the mover's move number ≤ openingLastMove; else middlegame.
 * - converting: mover's win % before the move ≥ convertingMinWin; defending: ≤ defendingMaxWin.
 * - timePressure: the mover's clock before the move is below max(timePressureSec,
 *   timePressureFrac × base time). Needs a clock reading and a timed game (daily games have none).
 */
export function areasOfPly(
  fenBefore: string,
  ply: number,
  winBeforeMover: number,
  clockBeforeSec: number | null,
  game: CoachGame,
): AreaKey[] {
  const out: AreaKey[] = [];
  const moveNumber = Math.floor(ply / 2) + 1;
  if (nonPawnMaterial(fenBefore) <= AREA_CFG.endgameMaxNonPawn) out.push('endgame');
  else if (moveNumber <= AREA_CFG.openingLastMove) out.push('opening');
  else out.push('middlegame');
  if (winBeforeMover >= AREA_CFG.convertingMinWin) out.push('converting');
  else if (winBeforeMover <= AREA_CFG.defendingMaxWin) out.push('defending');
  const limit = Math.max(AREA_CFG.timePressureSec, AREA_CFG.timePressureFrac * game.baseSec);
  if (clockBeforeSec !== null && game.baseSec > 0 && clockBeforeSec < limit) out.push('timePressure');
  return out;
}

/** One move of a cached game, with everything the diagnosis needs about it. */
export interface PlyFact {
  ply: number;
  mover: Color;
  /** True when the player (the game's `myColor`) made this move. */
  mine: boolean;
  fenBefore: string;
  san: string;
  /** Mover's win % before the move (50 before the first move). */
  winBeforeMover: number;
  /** Mover's win % lost by the move, never negative. */
  lossPts: number;
  /** Classified a mistake or blunder by the analysis. */
  mistake: boolean;
  areas: AreaKey[];
  /** Engine's preferred move here; null when the played move was the engine's choice. */
  bestSan: string | null;
}

/** Applies SAN moves to a board. */
type Mover = (san: string) => boolean;

/** chess.js internals that its own PGN loader uses: parse SAN and make the move without building a Move object. */
interface ChessInternals {
  _moveFromSan?: (san: string, strict?: boolean) => unknown;
  _makeMove?: (move: unknown) => void;
}

/**
 * Public `move()` builds a full Move object (two FENs and SAN) on every call, which makes
 * replaying hundreds of games about 3× slower. When chess.js exposes the internals its own
 * `loadPgn` uses, use them; otherwise fall back to `move()`. A test checks both give the
 * same positions.
 */
function moverFor(board: Chess): Mover {
  const b = board as unknown as ChessInternals;
  if (typeof b._moveFromSan === 'function' && typeof b._makeMove === 'function') {
    return (san) => {
      try {
        const m = b._moveFromSan!(san, false);
        if (!m) return false;
        b._makeMove!(m);
        return true;
      } catch {
        return false;
      }
    };
  }
  return (san) => {
    try {
      board.move(san);
      return true;
    } catch {
      return false;
    }
  };
}

/** The PGN's custom starting position ([FEN] tag), if the game didn't start from the usual one. */
export function customStartFen(pgn: string): string | undefined {
  return /\[FEN "([^"]+)"\]/.exec(pgn)?.[1];
}

function replay(c: CachedGame): PlyFact[] | null {
  const { game, analysis } = c;
  const startFen = customStartFen(game.pgn);
  let board: Chess;
  try {
    board = startFen ? new Chess(startFen) : new Chess();
  } catch {
    return null;
  }
  const move = moverFor(board);
  const plies = analysis.plies;
  const out: PlyFact[] = [];
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i];
    const fenBefore = board.fen();
    const mover: Color = fenBefore.split(' ', 2)[1] === 'w' ? 'white' : 'black';
    if (mover !== p.color || !move(p.moveSan)) return null;
    const beforeWhite = i === 0 ? 50 : plies[i - 1].winPctWhite;
    const winBeforeMover = mover === 'white' ? beforeWhite : 100 - beforeWhite;
    const winAfterMover = mover === 'white' ? p.winPctWhite : 100 - p.winPctWhite;
    // The mover's clock after their previous move; the starting clock for each side's first move.
    const clockBeforeSec = game.baseSec > 0 ? (i < 2 ? game.baseSec : (game.clocks[i - 2] ?? null)) : null;
    out.push({
      ply: i,
      mover,
      mine: mover === game.myColor,
      fenBefore,
      san: p.moveSan,
      winBeforeMover,
      lossPts: Math.max(0, winBeforeMover - winAfterMover),
      mistake: p.classification === 'mistake' || p.classification === 'blunder',
      areas: areasOfPly(fenBefore, i, winBeforeMover, clockBeforeSec, game),
      bestSan: p.bestMoveSan,
    });
  }
  return out;
}

const memo = new WeakMap<CachedGame, PlyFact[] | null>();

/**
 * Every move of a cached game with its position, areas and loss; null when the recorded
 * moves can't be replayed. Each game object is replayed once and remembered, so the
 * diagnosis, the baseline and the repeated-position search share one replay.
 */
export function gamePlies(c: CachedGame): PlyFact[] | null {
  if (memo.has(c)) return memo.get(c)!;
  const facts = replay(c);
  memo.set(c, facts);
  return facts;
}
