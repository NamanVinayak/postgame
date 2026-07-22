import type { Color, GameSummary, Outcome, TimeClass } from '../types';
import { RECENT_GAME_COUNT } from '../constants';

const API = 'https://api.chess.com/pub';

/** Chess.com result codes that mean a draw (everything non-win that isn't here is a loss). */
const DRAW_RESULTS = new Set([
  'stalemate',
  'agreed',
  'repetition',
  'insufficient',
  '50move',
  'timevsinsufficient',
]);

function resultToOutcome(result: string): Outcome {
  if (result === 'win') return 'win';
  if (DRAW_RESULTS.has(result)) return 'draw';
  return 'loss';
}

/**
 * Convert a raw Chess.com game object into our GameSummary, from `username`'s
 * perspective. Returns null for non-standard variants (only `rules === 'chess'`).
 */
export function normalizeGame(raw: any, username: string): GameSummary | null {
  if (!raw || raw.rules !== 'chess') return null;

  const lower = username.toLowerCase();
  const whiteIsMe = raw.white?.username?.toLowerCase() === lower;
  const blackIsMe = raw.black?.username?.toLowerCase() === lower;
  if (!whiteIsMe && !blackIsMe) return null;

  const myColor: Color = whiteIsMe ? 'white' : 'black';
  const me = whiteIsMe ? raw.white : raw.black;
  const them = whiteIsMe ? raw.black : raw.white;

  return {
    id: raw.url,
    url: raw.url,
    timeClass: raw.time_class as TimeClass,
    endTime: raw.end_time,
    rated: Boolean(raw.rated),
    myColor,
    outcome: resultToOutcome(me.result),
    opponent: { username: them.username, rating: them.rating },
    myRating: me.rating,
    pgn: raw.pgn,
  };
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Chess.com request failed: ${res.status}`);
  return res.json();
}

/** True if the username exists on Chess.com. */
export async function playerExists(username: string): Promise<boolean> {
  const res = await fetch(`${API}/player/${encodeURIComponent(username.toLowerCase())}`, {
    headers: { Accept: 'application/json' },
  });
  return res.ok;
}

/** Monthly archive URLs, oldest first. */
export async function fetchArchives(username: string): Promise<string[]> {
  const data = await getJson(
    `${API}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`,
  );
  return Array.isArray(data.archives) ? data.archives : [];
}

async function normalizeArchive(url: string, username: string): Promise<GameSummary[]> {
  const data = await getJson(url);
  const games: any[] = Array.isArray(data.games) ? data.games : [];
  return games
    .map((g) => normalizeGame(g, username))
    .filter((g): g is GameSummary => g !== null);
}

/**
 * The user's most recent games, newest first, capped at RECENT_GAME_COUNT.
 * Fetches the latest month; pulls the previous month too if that's not enough.
 */
export async function fetchRecentGames(username: string): Promise<GameSummary[]> {
  const archives = await fetchArchives(username);
  if (archives.length === 0) return [];

  let games = await normalizeArchive(archives[archives.length - 1], username);
  if (games.length < RECENT_GAME_COUNT && archives.length > 1) {
    const prev = await normalizeArchive(archives[archives.length - 2], username);
    games = games.concat(prev);
  }

  games.sort((a, b) => b.endTime - a.endTime);
  return games.slice(0, RECENT_GAME_COUNT);
}
