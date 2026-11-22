/**
 * The student file: what the coach remembers about a player between sessions (spec §6b).
 * One JSON file per player at `<coachHome>/students/<lowercased primary username>.json`,
 * outside the repo. It holds each session's focus, the positions tried (right or wrong),
 * the thinking errors the coach noted and the session's rule of thumb.
 *
 * The edit functions are pure (they return a new StudentFile); only `saveStudent` writes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coachHome } from '../config';

export interface Attempted {
  gameId: string;
  ply: number;
  moveSan: string;
  correct: boolean;
  /** Win-% points the move lost against the best move, at display depth. */
  lossPts: number;
  /**
   * The board (position key: board, side to move, castling, en passant), so the same board
   * reached in another game is known as the same. Missing in older files.
   */
  key?: string;
}

export interface StudentSession {
  /** When the session started (ms since 1970). */
  at: number;
  /** The session's focus in plain words, e.g. "the endgame". */
  focus: string | null;
  tried: Attempted[];
  thinkingNotes: string[];
  rule: string | null;
}

export interface StudentFile {
  username: string;
  createdAt: number;
  sessions: StudentSession[];
}

/** Chess.com usernames are letters, digits, "_" and "-"; nothing else may reach a file name. */
const USERNAME = /^[A-Za-z0-9_-]{1,50}$/;

/** True for a plain Chess.com username (letters, digits, "_" and "-"). */
export const isUsername = (username: string): boolean => USERNAME.test(username);

function checkedName(username: string): string {
  if (!isUsername(username)) throw new Error(`Not a Chess.com username: "${username}"`);
  return username.toLowerCase();
}

/** Where a player's student file lives. Throws on a username that isn't a plain Chess.com name. */
export function studentPath(username: string): string {
  return join(coachHome(), 'students', `${checkedName(username)}.json`);
}

export function emptyStudent(username: string, now = Date.now()): StudentFile {
  return { username: checkedName(username), createdAt: now, sessions: [] };
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

function toAttempt(x: unknown): Attempted | null {
  if (!isObj(x)) return null;
  const { gameId, ply, moveSan, correct, lossPts, key } = x;
  if (typeof gameId !== 'string' || typeof moveSan !== 'string' || typeof correct !== 'boolean') return null;
  if (typeof ply !== 'number' || !Number.isInteger(ply) || ply < 0) return null;
  if (typeof lossPts !== 'number' || !Number.isFinite(lossPts)) return null;
  const a: Attempted = { gameId, ply, moveSan, correct, lossPts };
  if (typeof key === 'string') a.key = key;
  return a;
}

/**
 * A student file read from JSON, keeping only what has the right shape: a hand-edited or
 * half-written file can hold anything, and nothing downstream should trip over it. Null when
 * it isn't a student file at all.
 */
function toStudent(x: unknown, username: string): StudentFile | null {
  if (!isObj(x) || !Array.isArray(x.sessions)) return null;
  const sessions: StudentSession[] = x.sessions.filter(isObj).map((v) => ({
    at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0,
    focus: typeof v.focus === 'string' ? v.focus : null,
    tried: Array.isArray(v.tried) ? v.tried.map(toAttempt).filter((a): a is Attempted => a !== null) : [],
    thinkingNotes: Array.isArray(v.thinkingNotes) ? v.thinkingNotes.filter((n): n is string => typeof n === 'string') : [],
    rule: typeof v.rule === 'string' ? v.rule : null,
  }));
  const createdAt = typeof x.createdAt === 'number' && Number.isFinite(x.createdAt) ? x.createdAt : 0;
  return { username: checkedName(username), createdAt, sessions };
}

/**
 * The player's student file; an empty one (not written yet) when there is none. A file that
 * can't be read is moved aside (`<name>.json.unreadable-<time>`), never overwritten. Entries
 * of the wrong shape in a readable file are dropped.
 */
export function loadStudent(username: string): StudentFile {
  const file = studentPath(username);
  if (!existsSync(file)) return emptyStudent(username);
  const raw = readFileSync(file, 'utf8');
  try {
    const parsed = toStudent(JSON.parse(raw), username);
    if (parsed) return parsed;
  } catch {
    // fall through: kept aside below
  }
  renameSync(file, `${file}.unreadable-${Date.now()}`);
  return emptyStudent(username);
}

/** Writes the whole file (temp file + rename, so a killed process never leaves half a file). */
export function saveStudent(s: StudentFile): void {
  const file = studentPath(s.username);
  mkdirSync(join(coachHome(), 'students'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Opens a new session; later attempts, notes and the rule go into it. */
export function startSession(s: StudentFile, focus: string | null, at = Date.now()): StudentFile {
  return { ...s, sessions: [...s.sessions, { at, focus, tried: [], thinkingNotes: [], rule: null }] };
}

/** The file with its current (last) session changed by `edit`; opens one first if there is none. */
function editCurrent(s: StudentFile, edit: (cur: StudentSession) => StudentSession): StudentFile {
  const withOne = s.sessions.length > 0 ? s : startSession(s, null);
  const last = withOne.sessions.length - 1;
  return { ...withOne, sessions: withOne.sessions.map((x, i) => (i === last ? edit(x) : x)) };
}

/** Appends a tried position to the current session. */
export function recordAttempt(s: StudentFile, a: Attempted): StudentFile {
  return editCurrent(s, (cur) => ({ ...cur, tried: [...cur.tried, { ...a }] }));
}

/** Appends a thinking error the coach noticed to the current session. */
export function addThinkingNote(s: StudentFile, note: string): StudentFile {
  return editCurrent(s, (cur) => ({ ...cur, thinkingNotes: [...cur.thinkingNotes, note] }));
}

/** Sets the current session's rule of thumb. */
export function setRule(s: StudentFile, rule: string): StudentFile {
  return editCurrent(s, (cur) => ({ ...cur, rule }));
}

export interface SessionSummary {
  at: number;
  focus: string | null;
  right: number;
  tried: number;
  thinkingNotes: string[];
  rule: string | null;
  /** The last position they got wrong (else the last one tried), to ask again as the warm-up. */
  warmUp: { gameId: string; ply: number } | null;
  text: string;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A session's first try at each board, in order: only the first try at a position counts
 * (later ones come after the answer was shown). Boards are told apart by `key`, or by game and
 * ply in older entries without one.
 */
export function firstTries(session: StudentSession): Attempted[] {
  const seen = new Set<string>();
  return session.tried.filter((t) => {
    const k = t.key ?? `${t.gameId}#${t.ply}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The last session before index `before` (default: all sessions) in which anything was
 * tried or noted, in plain words: "Last time (2026-11-18, focus: the endgame): 4 of 7 right."
 * Pass the running session's index as `before` so a session that has just started doesn't
 * hide the one before it. Null when there is no such session.
 */
export function lastSessionSummary(s: StudentFile, before = s.sessions.length): SessionSummary | null {
  const earlier = s.sessions.slice(0, Math.max(0, before));
  const last = [...earlier].reverse().find((x) => x.tried.length > 0 || x.thinkingNotes.length > 0);
  if (!last) return null;
  const firsts = firstTries(last);
  const right = firsts.filter((t) => t.correct).length;
  const wrong = [...firsts].reverse().find((t) => !t.correct);
  const pick = wrong ?? firsts.at(-1);
  const parts = [`Last time (${dayOf(last.at)}${last.focus ? `, focus: ${last.focus}` : ''}): ${right} of ${firsts.length} right.`];
  if (last.thinkingNotes.length > 0) parts.push(`Thinking errors noted: ${last.thinkingNotes.join('; ')}.`);
  if (last.rule) parts.push(`Rule of thumb: ${last.rule}`);
  return {
    at: last.at,
    focus: last.focus,
    right,
    tried: firsts.length,
    thinkingNotes: last.thinkingNotes,
    rule: last.rule,
    warmUp: pick ? { gameId: pick.gameId, ply: pick.ply } : null,
    text: parts.join(' '),
  };
}
