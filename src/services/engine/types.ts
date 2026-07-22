/** A position evaluation, from the side-to-move's point of view. */
export interface Evaluation {
  /** Centipawns (positive = side-to-move is better). Null when `mate` is set. */
  cp: number | null;
  /** Signed mate distance (positive = side-to-move mates). Null when not forced. */
  mate: number | null;
  /** Engine's best move in UCI/long algebraic (e.g. "e2e4", "e7e8q"), or null. */
  bestMoveUci: string | null;
}

export interface Engine {
  evaluate(fen: string, movetimeMs: number): Promise<Evaluation>;
}
