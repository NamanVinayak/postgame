import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addThinkingNote,
  emptyStudent,
  lastSessionSummary,
  loadStudent,
  recordAttempt,
  saveStudent,
  setRule,
  startSession,
  studentPath,
} from './student';

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.POSTGAME_COACH_HOME;
  home = mkdtempSync(join(tmpdir(), 'coach-student-'));
  process.env.POSTGAME_COACH_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.POSTGAME_COACH_HOME;
  else process.env.POSTGAME_COACH_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const A1 = { gameId: 'https://example.test/game/1', ply: 5, moveSan: 'Bc5', correct: true, lossPts: 0, key: 'k1' };
const A2 = { gameId: 'https://example.test/game/2', ply: 31, moveSan: 'Rxe4', correct: false, lossPts: 14.2 };

describe('student file', () => {
  it('studentFileRoundTrips: save then load gives the same object; recordAttempt appends to the current session', () => {
    let s = loadStudent('Alice');
    expect(s).toMatchObject({ username: 'alice', sessions: [] });
    expect(existsSync(studentPath('alice'))).toBe(false); // loading alone writes nothing

    s = recordAttempt(s, A1); // no session yet: one is opened
    expect(s.sessions).toHaveLength(1);
    s = recordAttempt(s, A2); // same session
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].tried).toEqual([A1, A2]);

    saveStudent(s);
    expect(studentPath('alice')).toBe(join(home, 'students', 'alice.json'));
    expect(loadStudent('ALICE')).toEqual(s);
    // Written whole (temp file + rename): nothing else is left in the folder.
    expect(readdirSync(join(home, 'students'))).toEqual(['alice.json']);
  });

  it('a new session collects later attempts, notes and the rule; earlier ones are untouched', () => {
    let s = recordAttempt(loadStudent('alice'), A1);
    s = startSession(s, 'the endgame', 2_000);
    s = recordAttempt(s, A2);
    s = addThinkingNote(s, "didn't ask what the last move threatened");
    s = setRule(s, 'Before each move, look at every check and capture for both sides.');
    expect(s.sessions).toHaveLength(2);
    expect(s.sessions[0].tried).toEqual([A1]);
    expect(s.sessions[1]).toEqual({
      at: 2_000,
      focus: 'the endgame',
      tried: [A2],
      thinkingNotes: ["didn't ask what the last move threatened"],
      rule: 'Before each move, look at every check and capture for both sides.',
    });
  });

  it('refuses a username that is not a plain Chess.com name (it becomes a file name)', () => {
    for (const bad of ['../x', 'a/b', '', 'a b', '..']) {
      expect(() => loadStudent(bad)).toThrow(/username/i);
    }
    expect(() => saveStudent({ ...emptyStudent('alice'), username: '../evil' })).toThrow(/username/i);
  });

  it('a malformed but valid JSON file loads what has the right shape, and the summary still works', () => {
    mkdirSync(join(home, 'students'), { recursive: true });
    const good = { gameId: 'g', ply: 3, moveSan: 'e5', correct: true, lossPts: 0 };
    writeFileSync(
      studentPath('alice'),
      JSON.stringify({
        username: 'alice',
        sessions: [
          { tried: 'oops', thinkingNotes: [1, 'missed a check'] },
          5,
          null,
          { at: Date.UTC(2026, 10, 20), focus: 7, tried: [good, { bad: 1 }, { ...good, ply: -1 }], rule: ['x'] },
        ],
      }),
    );
    const s = loadStudent('alice');
    expect(s.sessions).toEqual([
      { at: 0, focus: null, tried: [], thinkingNotes: ['missed a check'], rule: null },
      { at: Date.UTC(2026, 10, 20), focus: null, tried: [good], thinkingNotes: [], rule: null },
    ]);
    expect(lastSessionSummary(s)?.text).toBe('Last time (2026-11-20): 1 of 1 right.');
  });

  it('keeps an unreadable file aside instead of overwriting it', () => {
    mkdirSync(join(home, 'students'), { recursive: true });
    writeFileSync(studentPath('alice'), '{not json');
    const s = loadStudent('alice');
    expect(s.sessions).toEqual([]);
    const kept = readdirSync(join(home, 'students')).filter((f) => f.startsWith('alice.json.unreadable-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(home, 'students', kept[0]), 'utf8')).toBe('{not json');
  });
});

describe('lastSessionSummary (for the warm-up)', () => {
  const day = (d: number) => Date.UTC(2026, 10, d, 18);

  it('summarises the last earlier session with attempts: right count, notes, rule and a warm-up position', () => {
    let s = startSession(emptyStudent('alice'), 'the endgame', day(18));
    for (let i = 0; i < 7; i++) {
      s = recordAttempt(s, { gameId: `g${i}`, ply: 20 + i, moveSan: 'Kd2', correct: i < 4, lossPts: i < 4 ? 1 : 12 });
    }
    s = addThinkingNote(s, 'moved before checking the opponent’s threats');
    s = setRule(s, 'Ask what their last move threatens.');
    const sum = lastSessionSummary(s);
    expect(sum).not.toBeNull();
    expect(sum!.right).toBe(4);
    expect(sum!.tried).toBe(7);
    expect(sum!.text).toContain('Last time (2026-11-18, focus: the endgame): 4 of 7 right.');
    expect(sum!.text).toContain('moved before checking the opponent’s threats');
    expect(sum!.text).toContain('Ask what their last move threatens.');
    // The warm-up is the last position they got wrong.
    expect(sum!.warmUp).toEqual({ gameId: 'g6', ply: 26 });
  });

  it('a freshly opened session, still empty, does not hide "last time"', () => {
    let s = startSession(emptyStudent('alice'), 'the endgame', day(18));
    s = recordAttempt(s, A2);
    s = startSession(s, 'the endgame', day(22)); // today, nothing tried yet
    const sum = lastSessionSummary(s);
    expect(sum?.text).toContain('Last time (2026-11-18');
    expect(sum?.warmUp).toEqual({ gameId: A2.gameId, ply: A2.ply });
  });

  it("skips the session that is running now, so a mid-session call still reports the one before", () => {
    let s = startSession(emptyStudent('alice'), null, day(18));
    s = recordAttempt(s, A2);
    s = startSession(s, null, day(22));
    s = recordAttempt(s, A1);
    expect(lastSessionSummary(s, 1)?.text).toContain('Last time (2026-11-18): 0 of 1 right.');
    expect(lastSessionSummary(s)?.text).toContain('Last time (2026-11-22): 1 of 1 right.');
  });

  it('counts only the first try at each board', () => {
    let s = startSession(emptyStudent('alice'), null, day(18));
    s = recordAttempt(s, { gameId: 'g1', ply: 4, moveSan: 'h6', correct: false, lossPts: 12, key: 'K' });
    s = recordAttempt(s, { gameId: 'g2', ply: 8, moveSan: 'Bc5', correct: true, lossPts: 0, key: 'K' }); // same board, after the answer
    expect(lastSessionSummary(s)?.text).toBe('Last time (2026-11-18): 0 of 1 right.');
  });

  it('is null for a first session', () => {
    expect(lastSessionSummary(emptyStudent('alice'))).toBeNull();
    expect(lastSessionSummary(startSession(emptyStudent('alice'), null, day(22)))).toBeNull();
  });
});
