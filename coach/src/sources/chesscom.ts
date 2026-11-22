import type { TimeClass } from '../../../src/types';
import { normalizeGame } from '../../../src/services/chesscom';
import { SOURCE_CFG, loadLocalConfig } from '../config';
import { parseClocks } from './pgnClocks';
import type { CoachGame, GameSource } from './types';

export { parseClocks } from './pgnClocks';
export type { CoachGame, GameSource } from './types';

const API = 'https://api.chess.com/pub';
const USER_AGENT = 'postgame-coach (+https://github.com/NamanVinayak/postgame)';

/** "180+2" -> 180/2, "600" -> 600/0; daily ("1/259200") has no meaningful clock -> 0/0. */
function parseTimeControl(tc: string): { baseSec: number; incSec: number } {
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc ?? '');
  if (!m) return { baseSec: 0, incSec: 0 };
  return { baseSec: Number(m[1]), incSec: m[2] ? Number(m[2]) : 0 };
}

/** One account's rated, standard-chess games of one time class, newest first, with pre-game ratings. */
type Candidate = Omit<CoachGame, 'myPreRating'>;

async function getJson(fetchImpl: typeof fetch, url: string): Promise<any> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Chess.com request failed: ${res.status} ${url}`);
  return res.json();
}

function withinWindow(c: Candidate, pre: number | null): boolean {
  const ref = pre ?? c.myRating;
  return Math.abs(c.opponent.rating - ref) <= SOURCE_CFG.ratingWindow;
}

async function fetchForUser(
  fetchImpl: typeof fetch,
  username: string,
  opts: { timeClass: TimeClass; maxGames: number; before?: number },
): Promise<CoachGame[]> {
  const data = await getJson(fetchImpl, `${API}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`);
  const archives: string[] = Array.isArray(data.archives) ? data.archives : [];

  const seen = new Set<string>();
  let cands: Candidate[] = []; // newest first
  let reachedStart = archives.length === 0;

  /** Games that pass the window, newest first. The oldest candidate's pre-rating is unknown until an older one shows up. */
  const evaluate = (final: boolean): CoachGame[] => {
    const out: CoachGame[] = [];
    const usable = final ? cands.length : cands.length - 1;
    for (let i = 0; i < usable; i++) {
      const pre = i + 1 < cands.length ? cands[i + 1].myRating : null;
      if (withinWindow(cands[i], pre)) out.push({ ...cands[i], myPreRating: pre });
    }
    return out;
  };

  for (let a = archives.length - 1; a >= 0; a--) {
    const month = await getJson(fetchImpl, archives[a]);
    const raws: any[] = Array.isArray(month.games) ? month.games : [];
    for (const raw of raws) {
      if (!raw || raw.rated !== true || raw.time_class !== opts.timeClass) continue;
      const g = normalizeGame(raw, username);
      if (!g || seen.has(g.id)) continue;
      // Games newer than `before` can't be dropped from the chain's *older* side, so just skip them.
      if (opts.before !== undefined && !(g.endTime < opts.before)) continue;
      seen.add(g.id);
      const tc = String(raw.time_control ?? '');
      cands.push({ ...g, username, timeControl: tc, ...parseTimeControl(tc), clocks: parseClocks(g.pgn ?? '') });
    }
    cands.sort((x, y) => y.endTime - x.endTime);
    if (a === 0) reachedStart = true;
    if (!reachedStart && evaluate(false).length >= opts.maxGames) break;
  }
  return evaluate(reachedStart).slice(0, opts.maxGames);
}

/**
 * Chess.com source. Walks each account's monthly archives newest first (one request at a time) until
 * it has `maxGames` games inside the rating window, then merges accounts, keeps the newest `maxGames`
 * overall and returns them oldest to newest.
 */
export function createChesscomSource(fetchImpl: typeof fetch = fetch): GameSource {
  return {
    async fetchGames(usernames, opts) {
      const excluded = new Set(loadLocalConfig().excludeAccounts.map((a) => a.toLowerCase()));
      const names: string[] = [];
      for (const u of usernames) {
        const key = u.toLowerCase();
        if (excluded.has(key) || names.some((n) => n.toLowerCase() === key)) continue;
        names.push(u);
      }
      const all: CoachGame[] = [];
      for (const name of names) all.push(...(await fetchForUser(fetchImpl, name, opts)));
      all.sort((x, y) => x.endTime - y.endTime);
      return all.slice(Math.max(0, all.length - opts.maxGames));
    },
  };
}
