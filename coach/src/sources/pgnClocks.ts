const CLK = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/;
// Either a {comment} or a whitespace-delimited token.
const TOKEN = /\{[^}]*\}|[^\s{}]+/g;
const MOVE_NUMBER = /^\d+\.+/;
const RESULT = /^(?:1-0|0-1|1\/2-1\/2|\*)$/;

/** "0:02:59.9" -> 179.9 */
function toSeconds(m: RegExpMatchArray): number {
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Seconds left on the mover's clock after each ply (index = ply), read from `[%clk h:mm:ss.s]`
 * comments. Plies with no clock tag are null, so a PGN without clocks gives an all-null array
 * as long as the game.
 */
export function parseClocks(pgn: string): (number | null)[] {
  const movetext = pgn
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('['))
    .join(' ');
  const clocks: (number | null)[] = [];
  for (const tok of movetext.match(TOKEN) ?? []) {
    if (tok.startsWith('{')) {
      const m = tok.match(CLK);
      if (m && clocks.length > 0) clocks[clocks.length - 1] = toSeconds(m);
      continue;
    }
    if (tok.startsWith('$') || RESULT.test(tok)) continue;
    const san = tok.replace(MOVE_NUMBER, '');
    if (san !== '') clocks.push(null);
  }
  return clocks;
}
