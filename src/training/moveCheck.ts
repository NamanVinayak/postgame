import { Chess, type Square } from 'chess.js';
import type { PackPosition, PackUsual } from './pack';

export type Verdict =
  | { kind: 'right'; san: string }
  | { kind: 'usual'; san: string; usual: PackUsual }
  | { kind: 'other'; san: string };

/** SAN of the move from → to in this position (auto-queen), or null if it isn't legal. */
export function tryMove(fen: string, from: string, to: string): string | null {
  try {
    return new Chess(fen).move({ from, to, promotion: 'q' }).san;
  } catch {
    return null;
  }
}

export function judge(position: PackPosition, san: string): Verdict {
  if (position.accept.includes(san)) return { kind: 'right', san };
  const usual = position.usual.find((u) => u.move === san);
  return usual ? { kind: 'usual', san, usual } : { kind: 'other', san };
}

function ownPieceOn(fen: string, square: string): boolean {
  const chess = new Chess(fen);
  const piece = chess.get(square as Square);
  return !!piece && piece.color === chess.turn();
}

/** Tap-to-move: first tap picks up one of your pieces, second tap asks for the move. */
export function tapSquare(
  selected: string | null,
  square: string,
  fen: string,
): { selected: string | null; move: { from: string; to: string } | null } {
  if (selected === square) return { selected: null, move: null };
  if (ownPieceOn(fen, square)) return { selected: square, move: null };
  if (selected) return { selected: null, move: { from: selected, to: square } };
  return { selected: null, move: null };
}

/** A drag: ending on another square asks for the move; ending where it started (a finger wobble) picks the piece up. */
export function dropPiece(
  selected: string | null,
  from: string,
  to: string | null,
  fen: string,
): { selected: string | null; move: { from: string; to: string } | null } {
  if (to && to !== from) return { selected: null, move: { from, to } };
  return ownPieceOn(fen, from) ? { selected: from, move: null } : { selected, move: null };
}
