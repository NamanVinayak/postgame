export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily';
export type Outcome = 'win' | 'loss' | 'draw';
export type Color = 'white' | 'black';

export interface GameSummary {
  /** Stable unique id — the Chess.com game URL. */
  id: string;
  url: string;
  timeClass: TimeClass;
  /** Unix seconds. */
  endTime: number;
  rated: boolean;
  /** Color the connected user played. */
  myColor: Color;
  /** Result from the connected user's perspective. */
  outcome: Outcome;
  opponent: { username: string; rating: number };
  myRating: number;
  pgn: string;
}

export type Classification =
  | 'great'
  | 'best'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

export interface PlyAnalysis {
  /** 0-based ply index. */
  ply: number;
  moveSan: string;
  /** Who made this move. */
  color: Color;
  /** Eval of the position after the move, White POV, centipawns. Null if mate. */
  evalCp: number | null;
  /** Signed mate distance (White POV) if the position is a forced mate. */
  mate: number | null;
  /** Win probability for White after the move, 0..100. */
  winPctWhite: number;
  classification: Classification;
  isMissedWin: boolean;
  /**
   * Chess.com-style "Miss": the best move would have gained a clear advantage
   * but the played move let the opportunity pass (position left level or
   * worse). Distinct from a missed win — the position was not already won.
   */
  isMiss: boolean;
  /** Engine's preferred move in SAN (null when the played move was best). */
  bestMoveSan: string | null;
  /**
   * The engine's best line from the position *before* this move, in SAN, up
   * to BEST_LINE_MAX_MOVES long. Null when the engine reported no PV.
   * The first move is `bestMoveSan`.
   */
  bestLineSan: string[] | null;
  /** Same line in UCI, used to step the board through the line. */
  bestLineUci: string[] | null;
  /** Plain-English explanation, only for notable mistakes (else null). */
  reason: string | null;
  /** Accuracy of this single move, mover's POV, 0..100. */
  accuracy: number;
}

export interface AnalysisResult {
  gameId: string;
  schemaVersion: number;
  plies: PlyAnalysis[];
  whiteAccuracy: number;
  blackAccuracy: number;
  counts: {
    white: Record<Classification, number>;
    black: Record<Classification, number>;
  };
  /** Missed wins per color (a move can be both a blunder and a missed win). */
  missedWins: { white: number; black: number };
  /** Misses ("missed opportunities") per color. */
  misses: { white: number; black: number };
  createdAt: number;
}
