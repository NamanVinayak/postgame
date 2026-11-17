import { Chess, type PieceSymbol } from 'chess.js';

function playUci(board: Chess, uci: string): void {
  board.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: (uci.length > 4 ? uci[4] : undefined) as PieceSymbol | undefined,
  });
}

/**
 * Convert a UCI line (e.g. an engine PV) starting from `fenBefore` into SAN
 * moves. Returns null if any move is illegal in the position it is played
 * from — callers treat a null line as "no line available".
 */
export function uciLineToSan(fenBefore: string, uciMoves: string[]): string[] | null {
  try {
    const board = new Chess(fenBefore);
    const san: string[] = [];
    for (const uci of uciMoves) {
      const move = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: (uci.length > 4 ? uci[4] : undefined) as PieceSymbol | undefined,
      });
      san.push(move.san);
    }
    return san;
  } catch {
    return null;
  }
}

/**
 * FENs along a UCI line: index 0 is `fenBefore`, index k is the position
 * after the first k line moves. Returns null if any move is illegal.
 */
export function linePositions(fenBefore: string, uciMoves: string[]): string[] | null {
  try {
    const board = new Chess(fenBefore);
    const fens = [board.fen()];
    for (const uci of uciMoves) {
      playUci(board, uci);
      fens.push(board.fen());
    }
    return fens;
  } catch {
    return null;
  }
}

/** One tappable chip in the line display: label with move number, and the step it jumps to. */
export interface LineChip {
  label: string;
  /** 1-based step along the line (0 is the position before the line starts). */
  step: number;
}

/**
 * Render a SAN line as chips with standard move numbering. `startPly` is the
 * 0-based ply index of the game move this line replaces — the line's first
 * move is by the same color as that game move, so e.g. a line starting on
 * Black's 6th move renders "6... Nf6 7. Qxd4 ...".
 */
export function lineChips(lineSan: string[], startPly: number): LineChip[] {
  return lineSan.map((san, i) => {
    const ply = startPly + i;
    const moveNo = Math.floor(ply / 2) + 1;
    const isWhite = ply % 2 === 0;
    let label = san;
    if (i === 0 && !isWhite) label = `${moveNo}... ${san}`;
    else if (isWhite) label = `${moveNo}. ${san}`;
    return { label, step: i + 1 };
  });
}

/** The whole line as one string, e.g. "6... Nf6 7. Qxd4 Nxd4". */
export function formatLineSan(lineSan: string[], startPly: number): string {
  return lineChips(lineSan, startPly)
    .map((c) => c.label)
    .join(' ');
}
