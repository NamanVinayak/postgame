import { Chess, type PieceSymbol } from 'chess.js';
import type { Classification } from '../types';

export interface ReasonCtx {
  /** Position before the played move. */
  fenBefore: string;
  /** Position after the played move (opponent to move). */
  fenAfter: string;
  playedSan: string;
  bestMoveSan: string | null;
  classification: Classification;
  isMissedWin: boolean;
  /** The engine's best line from fenBefore was a forced mate the player missed. */
  bestLeadsToMate: boolean;
  /** The engine's best reply for the opponent from fenAfter, in SAN. */
  opponentReplySan: string | null;
}

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 100,
};

/** Detect the mover leaving a piece (>= minor) hanging: undefended and taken. */
function detectHanging(ctx: ReasonCtx): string | null {
  if (!ctx.opponentReplySan) return null;

  let captured: PieceSymbol | undefined;
  let toSquare: string | undefined;
  try {
    const board = new Chess(ctx.fenAfter);
    const reply = board.move(ctx.opponentReplySan);
    captured = reply.captured;
    toSquare = reply.to;
  } catch {
    return null;
  }
  if (!captured || !toSquare) return null;
  if (PIECE_VALUES[captured] < 3) return null;

  const position = new Chess(ctx.fenAfter);
  const moverColor = position.turn() === 'w' ? 'b' : 'w';
  const defenders = position.attackers(toSquare as never, moverColor);
  if (defenders.length > 0) return null;

  return `This leaves your ${PIECE_NAMES[captured]} hanging — after ${ctx.opponentReplySan} it's lost.`;
}

/**
 * Plain-English explanation for a notable mistake, or null when the move isn't
 * worth explaining (best / good / minor inaccuracies that aren't missed wins).
 */
export function explainMistake(ctx: ReasonCtx): string | null {
  const notable =
    ctx.isMissedWin ||
    ctx.classification === 'blunder' ||
    ctx.classification === 'mistake';
  if (!notable) return null;

  const best = ctx.bestMoveSan;

  if (ctx.isMissedWin && ctx.bestLeadsToMate) {
    return best
      ? `You missed a forced checkmate — ${best} was winning.`
      : 'You missed a forced checkmate.';
  }
  if (ctx.isMissedWin) {
    return best
      ? `You had a strong move here — ${best} kept your advantage.`
      : 'You had a strong move here.';
  }

  const hanging = detectHanging(ctx);
  if (hanging) return hanging;

  return best ? `A stronger move was ${best}.` : 'A stronger move was available.';
}
