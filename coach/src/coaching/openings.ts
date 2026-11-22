/**
 * Opening names from Chess.com PGN headers, for the report card and for grouping a player's
 * games by opening family when practice needs more positions.
 */

/** Chess.com's URL slugs drop the hyphen of these names. */
const HYPHENATED = new Set([
  'Caro-Kann', 'Nimzo-Indian', 'Bogo-Indian', 'Semi-Slav', 'Semi-Tarrasch', 'Smith-Morra', 'Mieses-Kotroc',
  'Nimzo-Larsen', 'Nimzowitsch-Larsen', 'Richter-Rauzer', 'Schliemann-Jaenisch', 'Hyper-Accelerated',
]);
/** ...and the apostrophe of these. */
const POSSESSIVE: Record<string, string> = {
  Queens: "Queen's", Kings: "King's", Bishops: "Bishop's", Petrovs: "Petrov's", Alekhines: "Alekhine's",
  Owens: "Owen's", Birds: "Bird's", Larsens: "Larsen's", Damianos: "Damiano's", Grobs: "Grob's",
};
/** The word that ends an opening's family name ("Caro-Kann Defense"), before its variation. */
const FAMILY_END = new Set(['Defense', 'Opening', 'Game', 'Gambit', 'Attack', 'System', 'Countergambit']);
const FAMILY_TAIL = new Set(['Accepted', 'Declined', 'Refused', 'Deferred']);

const header = (pgn: string, name: string) => new RegExp(`\\[${name} "([^"]*)"\\]`).exec(pgn)?.[1]?.trim() || null;

/** Drops a trailing move sequence ("…, 2...Nc6", "-3...cxd5-4.Bd3") and dangling punctuation. */
function withoutMoves(s: string, moveStart: RegExp): string {
  const m = moveStart.exec(s);
  return (m ? s.slice(0, m.index) : s).replace(/[\s,:;.-]+$/, '').replace(/\s+(with|and|of)$/i, '');
}

/** "Caro-Kann-Defense-Exchange-Variation" → "Caro-Kann Defense: Exchange Variation". */
function fromSlug(slug: string): string | null {
  // Moves start at "-3.", "...", or "-with-1-d4" (a move written without its dot).
  const raw = withoutMoves(slug, /-?\d+\.|\.\.\.|-with-\d/).split('-').filter(Boolean);
  const words: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const pair = `${raw[i]}-${raw[i + 1]}`;
    if (i + 1 < raw.length && HYPHENATED.has(pair)) {
      words.push(pair);
      i++;
    } else {
      words.push(POSSESSIVE[raw[i]] ?? raw[i]);
    }
  }
  if (words.length === 0) return null;
  let end = words.findIndex((w) => FAMILY_END.has(w));
  if (end >= 0 && FAMILY_TAIL.has(words[end + 1])) end++;
  if (end < 0 || end === words.length - 1) return words.join(' ');
  return `${words.slice(0, end + 1).join(' ')}: ${words.slice(end + 1).join(' ')}`;
}

/**
 * A readable opening name from a game's PGN headers: the `[Opening]` header when there is one,
 * else Chess.com's `[ECOUrl]` turned into words, without any move sequence. Null when neither
 * names an opening.
 */
export function openingName(pgn: string): string | null {
  const opening = header(pgn, 'Opening');
  if (opening) return withoutMoves(opening, /\s\d+\.|\.\.\./) || null;
  const url = header(pgn, 'ECOUrl');
  const slug = url ? /\/openings\/([^?#]+)/.exec(url)?.[1] : undefined;
  if (!slug) return null;
  try {
    return fromSlug(decodeURIComponent(slug));
  } catch {
    return null;
  }
}

/**
 * One name for a position reached in several games: the most common opening family (the part
 * before ":"; ties go to the first seen), named as far as all its games agree, word by word.
 */
export function commonOpening(names: string[]): string | null {
  if (names.length === 0) return null;
  const family = (n: string) => n.split(':')[0].trim();
  const counts = new Map<string, number>();
  for (const n of names) counts.set(family(n), (counts.get(family(n)) ?? 0) + 1);
  let top = family(names[0]);
  for (const [f, k] of counts) if (k > counts.get(top)!) top = f;
  const same = names.filter((n) => family(n) === top).map((n) => n.split(' '));
  const prefix: string[] = [];
  for (let i = 0; same.every((w) => w[i] !== undefined && w[i] === same[0][i]); i++) prefix.push(same[0][i]);
  const agreed = prefix.join(' ').replace(/[\s,:;]+$/, '');
  return agreed.length > top.length ? agreed : top;
}

/** The family of an opening name: the part before ":" ("Sicilian Defense: Alapin Variation" → "Sicilian Defense"). */
export function openingFamily(name: string): string {
  return name.split(':')[0].trim();
}
