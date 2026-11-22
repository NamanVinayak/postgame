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

function checkedName(username: string): string {
  if (!USERNAME.test(username)) throw new Error(`Not a Chess.com username: "${username}"`);
  return username.toLowerCase();
}

/** Where a player's student file lives. Throws on a username that isn't a plain Chess.com name. */
export function studentPath(username: string): string {
  return join(coachHome(), 'students', `${checkedName(username)}.json`);
}

export function emptyStudent(username: string, now = Date.now()): StudentFile {
  return { username: checkedName(username), createdAt: now, sessions: [] };
}

function looksLikeStudent(x: unknown): x is StudentFile {
  const s = x as StudentFile;
  return typeof s === 'object' && s !== null && typeof s.username === 'string' && Array.isArray(s.sessions);
}

/**
 * The player's student file; an empty one (not written yet) when there is none. A file that
 * can't be read is moved aside (`<name>.json.unreadable-<time>`), never overwritten.
 */
export function loadStudent(username: string): StudentFile {
  const file = studentPath(username);
  if (!existsSync(file)) return emptyStudent(username);
  const raw = readFileSync(file, 'utf8');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (looksLikeStudent(parsed)) return parsed;
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
 * The last session before index `before` (default: all sessions) in which anything was
 * tried or noted, in plain words: "Last time (2026-11-18, focus: the endgame): 4 of 7 right."
 * Pass the running session's index as `before` so a session that has just started doesn't
 * hide the one before it. Null when there is no such session.
 */
export function lastSessionSummary(s: StudentFile, before = s.sessions.length): SessionSummary | null {
  const earlier = s.sessions.slice(0, Math.max(0, before));
  const last = [...earlier].reverse().find((x) => x.tried.length > 0 || x.thinkingNotes.length > 0);
  if (!last) return null;
  const right = last.tried.filter((t) => t.correct).length;
  const wrong = [...last.tried].reverse().find((t) => !t.correct);
  const pick = wrong ?? last.tried.at(-1);
  const parts = [`Last time (${dayOf(last.at)}${last.focus ? `, focus: ${last.focus}` : ''}): ${right} of ${last.tried.length} right.`];
  if (last.thinkingNotes.length > 0) parts.push(`Thinking errors noted: ${last.thinkingNotes.join('; ')}.`);
  if (last.rule) parts.push(`Rule of thumb: ${last.rule}`);
  return {
    at: last.at,
    focus: last.focus,
    right,
    tried: last.tried.length,
    thinkingNotes: last.thinkingNotes,
    rule: last.rule,
    warmUp: pick ? { gameId: pick.gameId, ply: pick.ply } : null,
    text: parts.join(' '),
  };
}
