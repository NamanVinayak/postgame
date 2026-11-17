/** Parsed UCI `info ...` line carrying a score (and possibly a PV). */
export interface UciInfo {
  /** MultiPV tier (1 = best line). Defaults to 1 when the line omits multipv. */
  tier: number;
  /** Centipawns from the side-to-move's POV. Null when `mate` is set. */
  cp: number | null;
  /** Signed mate distance from the side-to-move's POV. Null when not forced. */
  mate: number | null;
  /** Principal variation in UCI, if the line carried one. */
  pv: string[] | null;
}

/**
 * Parse a UCI `info depth ... score cp|mate N [multipv M] [pv ...]` line.
 * Returns null for lines that carry no score (e.g. `info string ...`,
 * currmove/currline updates). The PV is split on whitespace and trimmed so a
 * trailing space never yields an empty "move".
 */
export function parseUciInfo(line: string): UciInfo | null {
  if (!line.startsWith('info') || !line.includes(' score ')) return null;
  const m = /score (cp|mate) (-?\d+)/.exec(line);
  if (!m) return null;
  const mpv = /multipv (\d+)/.exec(line);
  const pvMatch = / pv ([a-z0-9 ]+)/.exec(line);
  return {
    tier: mpv ? parseInt(mpv[1], 10) : 1,
    cp: m[1] === 'cp' ? parseInt(m[2], 10) : null,
    mate: m[1] === 'mate' ? parseInt(m[2], 10) : null,
    pv: pvMatch ? pvMatch[1].trim().split(/\s+/) : null,
  };
}

/**
 * Parse a `bestmove e2e4 [ponder ...]` line. Returns the best move in UCI,
 * or null when the line isn't a bestmove or the engine reports no legal move
 * (`bestmove (none)`, e.g. checkmate/stalemate positions).
 */
export function parseBestmove(line: string): string | null {
  if (!line.startsWith('bestmove')) return null;
  const parts = line.trim().split(/\s+/);
  const move = parts[1];
  if (!move || move === '(none)') return null;
  return move;
}
