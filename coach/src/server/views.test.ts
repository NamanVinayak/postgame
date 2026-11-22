import { describe, expect, it } from 'vitest';
import type { PositionFacts } from '../coaching/positionFacts';
import {
  parseCoachView,
  toAnswerView,
  toQuestionView,
  toReportView,
  toStatusView,
  costlyMovesText,
  heroFromConversion,
  heroFromTimeLosses,
  quickFixFromPosition,
  type QuickFix,
  type ReportView,
  type ReportPosition,
} from './views';

// Made-up position after 1.e4 e5 2.Nf3 Nc6 3.Bc4, Black to move. Moves and numbers are fixture
// values, not engine output; the win numbers are chosen so they can't appear by accident in a FEN.
const FEN_BEFORE = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const FEN_AFTER = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

function facts(over: Partial<PositionFacts> = {}): PositionFacts {
  return {
    gameId: 'game-1',
    ply: 5,
    fenBefore: FEN_BEFORE,
    fenAfter: FEN_AFTER,
    mover: 'black',
    playedSan: 'Nf6',
    playedUci: 'g8f6',
    bestSan: 'Bc5',
    bestUci: 'f8c5',
    bestLineSan: ['Bc5', 'c3', 'Nf6', 'd4'],
    refutationSan: ['Ng5', 'd5', 'exd5', 'Na5'],
    winBefore: 57.6,
    winAfter: 38.4,
    classification: 'mistake',
    reason: 'Leaves f7 open to attack.',
    gameUrl: 'https://www.chess.com/game/live/1',
    ...over,
  };
}

const PROMPT = 'What would you play, and what were you worried about?';

describe('toQuestionView', () => {
  it('questionViewLeaksNoAnswer', () => {
    const view = toQuestionView(facts(), PROMPT);
    expect(Object.keys(view).sort()).toEqual(['fen', 'gameId', 'kind', 'orientation', 'ply', 'prompt']);
    expect(view).toEqual({
      kind: 'question',
      fen: FEN_BEFORE, // the position before the move, never fenAfter (that would show the played move)
      orientation: 'black',
      gameId: 'game-1',
      ply: 5,
      prompt: PROMPT,
    });
    const json = JSON.stringify(view);
    for (const leak of ['bestSan', 'bestUci', 'playedSan', 'playedUci', 'bestLine', 'refutation', 'caption']) {
      expect(json).not.toContain(leak);
    }
    // No move from the answer, the played move or the refutation; no win % in any form.
    for (const leak of ['Nf6', 'Bc5', 'f8c5', 'g8f6', 'Ng5', FEN_AFTER, 'mistake', 'f7 open']) {
      expect(json).not.toContain(leak);
    }
    expect(json).not.toMatch(/win|%|57\.6|38\.4|58|38/i);
  });
});

describe('toAnswerView', () => {
  it('answerViewOrientsToMover', () => {
    const view = toAnswerView(facts());
    expect(view.kind).toBe('answer');
    if (view.kind !== 'answer') return;
    expect(view.orientation).toBe('black');
    expect(view.fen).toBe(FEN_BEFORE);
    expect(view.playedUci).toBe('g8f6');
    expect(view.playedSan).toBe('Nf6');
    expect(view.bestUci).toBe('f8c5');
    expect(view.bestSan).toBe('Bc5');
    expect(view.bestLineSan).toEqual(['Bc5', 'c3', 'Nf6', 'd4']);
    expect(view.winBefore).toBe(57.6);
    expect(view.winAfter).toBe(38.4);
    expect(view.caption).toContain('58%');
    expect(view.caption).toContain('38%');
    expect(view.caption).not.toContain('57.6');
    // The refutation has no slot in BoardView, so it is told in the caption.
    expect(view.caption).toContain('Ng5 d5 exd5');

    const white = toAnswerView(facts({ mover: 'white' }));
    expect(white.kind === 'answer' && white.orientation).toBe('white');
  });

  it('answerViewNoBestWhenPlayedWasBest', () => {
    // Cached facts mark "played was best" with a null best move (as root bestMoveSan does)...
    const fromCache = toAnswerView(facts({ bestSan: null, bestUci: null, playedSan: 'Bc5', playedUci: 'f8c5' }));
    // ...a deep search can instead return the played move as the best one.
    const fromDeep = toAnswerView(facts({ bestSan: 'Bc5', bestUci: 'f8c5', playedSan: 'Bc5', playedUci: 'f8c5' }));
    for (const view of [fromCache, fromDeep]) {
      expect(view.kind).toBe('answer');
      if (view.kind !== 'answer') return;
      expect(view.bestUci).toBeNull();
      expect(view.bestSan).toBeNull();
      expect(view.playedUci).toBe('f8c5');
      expect(view.playedSan).toBe('Bc5');
      expect(view.caption).toContain('Bc5 was the best move');
      expect(view.caption).not.toMatch(/best move was/);
      expect(view.caption).not.toContain('reply'); // no refutation of a best move
    }
  });
});

describe('toAnswerView with the student attempt', () => {
  it('answerViewShowsAttemptWhenGiven', () => {
    // Game move Nf6, best Bc5; the student tried Be7.
    const view = toAnswerView(facts(), { moveSan: 'Be7', moveUci: 'f8e7' });
    if (view.kind !== 'answer') throw new Error('not an answer');
    expect(view.playedSan).toBe('Be7'); // the red "Your move" is the attempt, not the game move
    expect(view.playedUci).toBe('f8e7');
    expect(view.bestSan).toBe('Bc5');
    expect(view.bestUci).toBe('f8c5');
    expect(view.orientation).toBe('black');
    expect(view.fen).toBe(FEN_BEFORE);
    expect(view.bestLineSan).toEqual(['Bc5', 'c3', 'Nf6', 'd4']);
    // The win % belong to the game move, so they are told as the game move's, never as the attempt's.
    expect(view.winBefore).toBe(57.6);
    expect(view.winAfter).toBeNull();
    expect(view.caption).toContain('You tried Be7; the best move is Bc5.');
    expect(view.caption).toContain('In the game you played Nf6: your win chance went from 58% to 38%.');
    expect(view.caption).not.toContain('Ng5'); // the refutation answers Nf6, not Be7
    expect(view.caption).not.toContain('f7 open'); // so does the reason

    // The attempt is the best move: one green arrow, no separate best.
    const best = toAnswerView(facts(), { moveSan: 'Bc5', moveUci: 'f8c5' });
    if (best.kind !== 'answer') throw new Error('not an answer');
    expect([best.playedSan, best.playedUci, best.bestSan, best.bestUci]).toEqual(['Bc5', 'f8c5', null, null]);
    expect(best.caption).toContain('Bc5 is the best move here.');

    // The game move was best (null best in the facts) and the student tried something else:
    // the game move is the best move to show.
    const gameWasBest = toAnswerView(facts({ bestSan: null, bestUci: null }), { moveSan: 'Be7', moveUci: 'f8e7' });
    if (gameWasBest.kind !== 'answer') throw new Error('not an answer');
    expect([gameWasBest.playedSan, gameWasBest.bestSan, gameWasBest.bestUci]).toEqual(['Be7', 'Nf6', 'g8f6']);

    // Trying the game move again is the same as no attempt.
    expect(toAnswerView(facts(), { moveSan: 'Nf6', moveUci: 'g8f6' })).toEqual(toAnswerView(facts()));
  });
});

// A real repeated position from a 900-game diagnosis: 1.e4 c5 2.Nf3 Nc6 3.Nc3 e6 4.d4 cxd4 5.Nxd4,
// Black to move; usually g6 or d5, best Nf6.
function position(over: Partial<ReportPosition> = {}): ReportPosition {
  return {
    fen: 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5',
    orientation: 'black',
    wrongSan: ['g6', 'd5'],
    wrongUci: 'g7g6',
    bestSan: 'Nf6',
    bestUci: 'g8f6',
    lossPts: 13.629230423597654,
    wrongTimes: 8,
    seenTimes: 9,
    opening: 'Sicilian Defense: Taimanov Variation',
    drillsDone: 0,
    drillsTotal: 3,
    ...over,
  };
}

describe('toStatusView', () => {
  it('statusViewRoundTrips', () => {
    const withProgress = toStatusView('Analysing your games', 'Checking each move with Stockfish.', { done: 312, total: 900 });
    expect(withProgress).toEqual({
      kind: 'status',
      title: 'Analysing your games',
      message: 'Checking each move with Stockfish.',
      progress: { done: 312, total: 900 },
    });
    const waiting = toStatusView('Getting your games', 'Downloading your blitz games.');
    expect(Object.keys(waiting).sort()).toEqual(['kind', 'message', 'title']); // no progress key at all
    const edges = [toStatusView('t', 'm', { done: 0, total: 0 }), toStatusView('t', 'm', { done: 900, total: 900 }), toStatusView('', '')];
    for (const view of [withProgress, waiting, ...edges]) {
      expect(parseCoachView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    }
  });

  it('statusViewRejectsBadProgress', () => {
    const good = toStatusView('t', 'm', { done: 1, total: 2 });
    expect(parseCoachView(good)).toEqual(good);
    const bad: unknown[] = [
      { ...good, progress: { done: 3, total: 2 } }, // more done than there are
      { ...good, progress: { done: -1, total: 2 } },
      { ...good, progress: { done: 1.5, total: 2 } },
      { ...good, progress: { done: 1, total: Number.POSITIVE_INFINITY } },
      { ...good, progress: { done: Number.NaN, total: 2 } },
      { ...good, progress: { done: '1', total: 2 } },
      { ...good, progress: { done: 1 } },
      { ...good, progress: [1, 2] },
      { ...good, progress: null },
      { ...good, title: 'x'.repeat(301) },
      { ...good, message: 'x'.repeat(301) },
      { ...good, title: 5 },
      { kind: 'status', title: 't' }, // no message
    ];
    for (const x of bad) expect(parseCoachView(x), JSON.stringify(x).slice(0, 80)).toBeNull();

    // The mapper never emits what the widget would refuse: bad progress is left out (the card
    // shows a plain waiting state), and over-long text is cut to fit.
    for (const p of [{ done: 3, total: 2 }, { done: -1, total: 2 }, { done: 1.5, total: 2 }, { done: Number.NaN, total: 2 }]) {
      const view = toStatusView('t', 'm', p);
      if (view.kind !== 'status') throw new Error('not a status');
      expect(view.progress, JSON.stringify(p)).toBeUndefined();
      expect(parseCoachView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    }
    const long = toStatusView('x'.repeat(400), 'y'.repeat(400));
    if (long.kind !== 'status') throw new Error('not a status');
    expect(long.title.length).toBeLessThanOrEqual(300);
    expect(long.message.length).toBeLessThanOrEqual(300);
    expect(long.message.endsWith('…')).toBe(true);
    expect(parseCoachView(long)).toEqual(long);
  });
});

describe('parseCoachView', () => {
  it('acceptsEveryMapperOutput', () => {
    const report = toReportView(spikeReport(), { positions: [board()], quickFixes: [quick(false)] });
    for (const view of [toAnswerView(facts()), toQuestionView(facts(), PROMPT), report, toStatusView('t', 'm')]) {
      expect(parseCoachView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    }
  });

  it('legacyReportShapeIsRefused', () => {
    // The v3 card (areas against players at your rating, missions carrying the best move) is gone:
    // a payload of that shape no longer parses, so no best move can reach the card through it.
    const v3 = {
      kind: 'report',
      headline: 'h',
      games: 300,
      timeClass: 'blitz',
      rows: [{ area: 'Endgames', label: 'gap', you: 9.1, them: 5.2, range: [6.4, 11.8], games: 120 }],
      focus: 'your endgames',
      positions: [{ ...position(), bestSan: 'Nf6', bestUci: 'g8f6' }],
    };
    expect(parseCoachView(v3)).toBeNull();
  });

  it('rejectsMalformedViews', () => {
    const answer = toAnswerView(facts());
    const question = toQuestionView(facts(), PROMPT);
    const report = toReportView(spikeReport());
    const bad: unknown[] = [
      null,
      'answer',
      { ...answer, kind: undefined }, // a bare BoardView without kind
      { ...answer, orientation: 'w' },
      { ...answer, bestLineSan: ['Bc5', 3] },
      { ...question, ply: '5' },
      { ...question, kind: 'quiz' },
      { ...report, hero: 'h' },
      { ...report, leaks: [{ ...report.leaks[0], range: [1] }] },
      { ...report, focus: { ...report.focus, positions: 'none' } },
      { ...report, games: -1 },
    ];
    for (const x of bad) expect(parseCoachView(x)).toBeNull();
  });
});

// ---- Report card v4 (spec §6c) ----

// P1's LeakReport, copied from its brief (and branch cf46caf) so the test proves a real one is
// assignable to LeakReportLike: the fixture is held in a variable of this type, not a fresh literal.
type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily';
type LeakKey = 'clock' | 'winning' | 'losing' | 'opening' | 'endgame' | 'middlegame';
interface Leak { key: LeakKey; label: string; sharePct: number; shareRange: [number, number]; bigMistakesPerGame: number; givenAwayPer10: number; oppGivenAwayPer10: number; moves: number }
interface Conversion { winningGames: number; won: number; drawn: number; lost: number; convertedPct: number; lostShareOfLossesPct: number; lostShareRange: [number, number]; oppWinningGames: number; oppConvertedPct: number }
interface TimeLosses { losses: number; onTime: number; sharePct: number }
interface WhatIf { label: string; extraScorePerGame: number; ratingPoints: number }
type LeakFocus = { kind: 'keepTheWin' } | { kind: 'clock' } | { kind: 'leak'; key: LeakKey };
interface LeakReport { usernames: string[]; timeClass: TimeClass; games: number; asOf: number; avgScore: number; leaks: Leak[]; conversion: Conversion; timeLosses: TimeLosses; whatIf: WhatIf | null; focus: LeakFocus; notes: string[] }

const leak = (key: LeakKey, label: string, sharePct: number, bigMistakesPerGame: number): Leak => ({
  key, label, sharePct, shareRange: [sharePct - 3, sharePct + 3], bigMistakesPerGame, givenAwayPer10: 1, oppGivenAwayPer10: 1, moves: 100,
});

/** Shaped like the controller's 900-game spike (fixture numbers; not engine output). */
function spikeReport(over: Partial<LeakReport> = {}): LeakReport {
  const r: LeakReport = {
    usernames: ['player'],
    timeClass: 'blitz',
    games: 900,
    asOf: 0,
    avgScore: 0.5,
    // Deliberately not in rank order: the mapper ranks them.
    leaks: [
      leak('winning', "When you're already winning", 24.2, 1.04),
      leak('middlegame', 'Balanced middlegames', 35.4, 1.83),
      leak('opening', 'Your first 10 moves', 20.6, 0.79),
      leak('clock', 'Low on the clock', 9.8, 0.4),
      leak('losing', "When you're already losing", 6.6, 0.3),
      leak('endgame', 'Endgames', 3.9, 0.2),
    ],
    conversion: { winningGames: 493, won: 340, drawn: 11, lost: 142, convertedPct: 69, lostShareOfLossesPct: 31.7, lostShareRange: [28, 35], oppWinningGames: 480, oppConvertedPct: 69.3 },
    timeLosses: { losses: 448, onTime: 72, sharePct: 16.1 },
    whatIf: { label: 'if you threw away half as many won positions', extraScorePerGame: 0.08, ratingPoints: 54 },
    focus: { kind: 'keepTheWin' },
    notes: [],
    ...over,
  };
  return r;
}

const WIN_FEN = 'r1bq1rk1/ppp2ppp/2n5/3np3/2B5/2N2N2/PPPP1PPP/R1BQR1K1 w - - 0 9';
const board = (over: Record<string, unknown> = {}) => ({ fen: WIN_FEN, orientation: 'white' as const, ...over });
const quick = (revealed: boolean): QuickFix => ({
  fen: 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5',
  orientation: 'black',
  label: 'Sicilian Defense: Taimanov Variation',
  times: '8 of 9 games',
  wrongSan: ['g6', 'd5'],
  wrongUci: 'g7g6',
  revealed,
  bestSan: 'Nf6',
  bestUci: 'g8f6',
});
const v4 = (x: ReportView): ReportView => x;

describe('report card v4', () => {
  it('reportV4RoundTrips', () => {
    const view = v4(
      toReportView(spikeReport(), {
        positions: [board(), board({ orientation: 'black', fen: '6k1/5ppp/8/8/8/8/1q3PPP/3R2K1 b - - 0 30' }), board()],
        drillsDone: 0,
        drillsTotal: 20,
        quickFixes: [quick(false)],
        cta: "Start this week's training",
      }),
    );
    expect(view.hero).toEqual({
      headline: 'You were winning in 493 games, and lost 142 of them.',
      sub: '1 in 3 of your losses were games you were winning.',
      source: 'thrownWins',
    });
    expect(view.leaks.map((l) => [l.label, l.sharePct, l.range, l.detail])).toEqual([
      ['Balanced middlegames', 35, [32, 38], 'About 2 costly moves per game'],
      ["When you're already winning", 24, [21, 27], 'About 1 costly move per game'],
      ['Your first 10 moves', 21, [18, 24], 'About 1 costly move per game'],
      ['Low on the clock', 10, [7, 13], '72 of your 448 losses were on time'],
      ["When you're already losing", 7, [4, 10], 'About 1 costly move every 3 games'],
      ['Endgames', 4, [1, 7], 'About 1 costly move every 5 games'],
    ]);
    expect(view.context).toBe('Your opponents keep the same share of their winning games as you (69%): normal at your level, and the biggest thing you control.');
    expect(view.focus).toMatchObject({
      title: 'Keep the win',
      line: '20 positions from your games where you were winning and let it slip.',
      estimate: 'About +55 rating points if you halve them (rough estimate)', // rounded to 5
      drillsDone: 0,
      drillsTotal: 20,
    });
    expect(view.focus.positions).toHaveLength(3);
    expect(view.focus.positions[0].prompt).toBe("You're winning here. Find the move that keeps it.");
    expect(parseCoachView(JSON.parse(JSON.stringify(view)))).toEqual(view);

    // Lean: no what-if, no boards, no quick fixes, no button; still a valid card, and no estimate.
    const lean = v4(toReportView(spikeReport({ whatIf: null })));
    expect(lean.focus.estimate).toBeUndefined();
    expect(Object.keys(lean).sort()).toEqual(['context', 'focus', 'games', 'hero', 'kind', 'leaks', 'timeClass']);
    expect(parseCoachView(JSON.parse(JSON.stringify(lean)))).toEqual(lean);

    // The other focus kinds use their own stat for the hero, and never the "halve them" estimate.
    const clock = v4(toReportView(spikeReport({ focus: { kind: 'clock' } })));
    expect(clock.hero).toEqual({ headline: '72 of your 448 losses were on time.', sub: '1 in 6 of your losses came from the clock, not the board.', source: 'clock' });
    expect(clock.focus.title).toBe('Beat the clock');
    expect(clock.focus.estimate).toBeUndefined();
    const mid = v4(toReportView(spikeReport({ focus: { kind: 'leak', key: 'middlegame' } })));
    expect(mid.hero).toEqual({ headline: 'Your biggest leak: balanced middlegames.', sub: '35% of the win chance you give away happens here.', source: 'middlegame' });
    expect(mid.focus.estimate).toBeUndefined();
    for (const v of [clock, mid]) expect(parseCoachView(JSON.parse(JSON.stringify(v)))).toEqual(v);
    // Plain words only.
    expect(JSON.stringify(view)).not.toMatch(/\bCI\b|bootstrap|p-value|confidence|resampl/i);
  });

  it('focusPositionsCarryNoAnswers', () => {
    // The server may hand over richer objects; only fen, orientation and prompt get through.
    const rich = board({ bestSan: 'Bxf7+', bestUci: 'c4f7', playedSan: 'Re3', bestLineSan: ['Bxf7+', 'Kxf7'], caption: 'Bxf7+ wins' });
    const view = v4(toReportView(spikeReport(), { positions: [rich as never] }));
    expect(Object.keys(view.focus.positions[0]).sort()).toEqual(['fen', 'orientation', 'prompt']);
    expect(JSON.stringify(view.focus)).not.toMatch(/Bxf7|c4f7|Re3|best|played|caption/);
    // And the widget's check refuses any board that carries anything more.
    for (const extra of [{ bestSan: 'Bxf7+' }, { bestUci: 'c4f7' }, { playedSan: 'Re3' }, { hint: 'look at f7' }]) {
      const bad = { ...view, focus: { ...view.focus, positions: [{ ...view.focus.positions[0], ...extra }] } };
      expect(parseCoachView(bad), JSON.stringify(extra)).toBeNull();
    }
    // Bad boards are dropped by the mapper, at most three are kept.
    const four = v4(toReportView(spikeReport(), { positions: [board(), board({ fen: 'nonsense' }), board(), board(), board()] }));
    expect(four.focus.positions).toHaveLength(3);
  });

  it('quickFixHidesAnswerUntilRevealed', () => {
    const hidden = v4(toReportView(spikeReport(), { quickFixes: [quick(false)] })).quickFixes?.[0];
    expect(hidden).toMatchObject({ revealed: false, bestSan: null, bestUci: null, wrongSan: ['g6', 'd5'], times: '8 of 9 games' });
    expect(JSON.stringify(hidden)).not.toMatch(/Nf6|g8f6/);
    const shown = v4(toReportView(spikeReport(), { quickFixes: [quick(true)] })).quickFixes?.[0];
    expect(shown).toMatchObject({ revealed: true, bestSan: 'Nf6', bestUci: 'g8f6' });

    // The widget's check: an unrevealed answer, or a revealed one that isn't a move, is refused.
    const base = v4(toReportView(spikeReport(), { quickFixes: [quick(false)] }));
    for (const q of [{ ...quick(false) }, { ...quick(false), bestSan: null }, { ...quick(true), bestSan: 'not a move' }, { ...quick(false), extra: 1 }]) {
      expect(parseCoachView({ ...base, quickFixes: [q] }), JSON.stringify(q).slice(0, 60)).toBeNull();
    }
    expect(parseCoachView({ ...base, quickFixes: [quick(true)] })).not.toBeNull();

    // From a repeated position: hidden until revealed.
    const rep = position();
    expect(quickFixFromPosition(rep, false)).toMatchObject({ bestSan: null, bestUci: null, times: '8 of 9 games', label: 'Sicilian Defense: Taimanov Variation' });
    expect(quickFixFromPosition(rep, true)).toMatchObject({ bestSan: 'Nf6', bestUci: 'g8f6' });
  });

  it('heroFromConversion', () => {
    const real = spikeReport().conversion;
    expect(heroFromConversion(real)).toEqual({
      headline: 'You were winning in 493 games, and lost 142 of them.',
      sub: '1 in 3 of your losses were games you were winning.',
    });
    const at = (lostShareOfLossesPct: number) => heroFromConversion({ winningGames: 40, lost: 10, lostShareOfLossesPct }).sub;
    expect(at(50)).toBe('1 in 2 of your losses were games you were winning.');
    expect(at(70)).toBe('1 in 2 of your losses were games you were winning.'); // N never below 2
    expect(at(85)).toBe('1 in 2 of your losses were games you were winning.');
    expect(at(86)).toBe('Almost all of your losses were games you were winning.'); // only above 85%
    expect(at(20)).toBe('1 in 5 of your losses were games you were winning.');
    expect(at(23)).toBe('1 in 4 of your losses were games you were winning.'); // 100 / 23 = 4.3
    expect(at(0)).toBe('None of your losses were games you were winning.');
    expect(at(97)).toBe('Almost all of your losses were games you were winning.');
    expect(heroFromConversion({ winningGames: 1, lost: 1, lostShareOfLossesPct: 100 }).headline).toBe('You were winning in 1 game, and lost 1 of them.');
  });

  it('rejectsMoreThanSixLeaks', () => {
    const view = v4(toReportView(spikeReport()));
    const seventh = { label: 'Something else', sharePct: 1, range: [0, 2] as [number, number], detail: '' };
    expect(parseCoachView({ ...view, leaks: [...view.leaks, seventh] })).toBeNull();
    // The mapper keeps the six largest.
    const seven = spikeReport({ leaks: [...spikeReport().leaks, leak('endgame', 'Rook endings', 1, 0.1)] });
    expect(v4(toReportView(seven)).leaks.map((l) => l.label)).not.toContain('Rook endings');
    // Bars must be ranked, and each one well formed.
    const swapped = [view.leaks[1], view.leaks[0], ...view.leaks.slice(2)];
    const badBars = [
      swapped,
      [{ ...view.leaks[0], sharePct: 101 }],
      [{ ...view.leaks[0], range: [40, 30] }],
      [{ ...view.leaks[0], sharePct: Number.NaN }],
      [{ ...view.leaks[0], label: '' }],
    ];
    for (const leaks of badBars) expect(parseCoachView({ ...view, leaks }), JSON.stringify(leaks[0]).slice(0, 60)).toBeNull();
    // Other card-level checks.
    expect(parseCoachView({ ...view, hero: { headline: '', sub: '' } })).toBeNull();
    expect(parseCoachView({ ...view, focus: { ...view.focus, drillsDone: 21 } })).toBeNull();
    expect(parseCoachView({ ...view, cta: '' })).toBeNull();
  });
});

describe('report card v4, review fixes', () => {
  it('heroNamesFocusLeakWithoutMajorityClaim', () => {
    // The top bar is 35%: a leak, not a majority, so no "one place" or "most".
    const top = v4(toReportView(spikeReport({ focus: { kind: 'leak', key: 'middlegame' } })));
    expect(top.hero).toEqual({ headline: 'Your biggest leak: balanced middlegames.', sub: '35% of the win chance you give away happens here.', source: 'middlegame' });
    // The focus is the second-ranked bar: it is this week's focus, not the biggest leak.
    const second = v4(toReportView(spikeReport({ focus: { kind: 'leak', key: 'winning' } })));
    expect(second.hero).toEqual({ headline: "Your focus this week: when you're already winning.", sub: '24% of the win chance you give away happens here.', source: 'winning' });
    for (const h of [top.hero, second.hero]) expect(`${h.headline} ${h.sub}`).not.toMatch(/one place|most|majority|biggest leak: when/i);
  });

  it('clockHeroAgreesInNumber', () => {
    expect(heroFromTimeLosses({ losses: 1, onTime: 1, sharePct: 100 }).headline).toBe('1 of your 1 loss was on time.');
    expect(heroFromTimeLosses({ losses: 448, onTime: 1, sharePct: 0.22 }).headline).toBe('1 of your 448 losses was on time.');
    expect(heroFromTimeLosses({ losses: 448, onTime: 72, sharePct: 16.07 })).toEqual({
      headline: '72 of your 448 losses were on time.',
      sub: '1 in 6 of your losses came from the clock, not the board.',
    });
    expect(heroFromTimeLosses({ losses: 10, onTime: 9, sharePct: 90 }).sub).toBe('Almost all of your losses were on time.');
    expect(heroFromTimeLosses({ losses: 10, onTime: 8, sharePct: 80 }).sub).toBe('1 in 2 of your losses came from the clock, not the board.');
    // The clock bar's line agrees too.
    const one = v4(toReportView(spikeReport({ timeLosses: { losses: 448, onTime: 1, sharePct: 0.22 } })));
    expect(one.leaks.find((l) => l.label === 'Low on the clock')?.detail).toBe('1 of your 448 losses was on time');
  });

  it('costlyMoveWording', () => {
    expect(costlyMovesText(1.83)).toBe('About 2 costly moves per game'); // >= 1.5: N rounded
    expect(costlyMovesText(1.5)).toBe('About 2 costly moves per game');
    expect(costlyMovesText(3.4)).toBe('About 3 costly moves per game');
    expect(costlyMovesText(1.49)).toBe('About 1 costly move per game'); // 0.75 to 1.5
    expect(costlyMovesText(0.75)).toBe('About 1 costly move per game');
    expect(costlyMovesText(0.74)).toBe('About 1 costly move every 2 games'); // below 0.75: N = max(2, round(1 / x))
    expect(costlyMovesText(0.6)).toBe('About 1 costly move every 2 games');
    expect(costlyMovesText(0.35)).toBe('About 1 costly move every 3 games');
    expect(costlyMovesText(0.3)).toBe('About 1 costly move every 3 games');
    expect(costlyMovesText(0.29)).toBe('About 1 costly move every 3 games');
    expect(costlyMovesText(0.2)).toBe('About 1 costly move every 5 games');
    expect(costlyMovesText(0.04)).toBe('About 1 costly move every 25 games');
    expect(costlyMovesText(0)).toBe('No costly moves here');
  });

  it('rangesFlagPassesThroughAndIsChecked', () => {
    const shaky = v4(toReportView({ ...spikeReport(), rangesReliable: false }));
    expect(shaky.rangesReliable).toBe(false);
    expect(parseCoachView(JSON.parse(JSON.stringify(shaky)))).toEqual(shaky);
    expect('rangesReliable' in v4(toReportView(spikeReport()))).toBe(false); // not given: no key
    expect(parseCoachView({ ...shaky, rangesReliable: 'no' })).toBeNull();
  });

  it('lessonPromptsArePlainOutsideKeepTheWin', () => {
    // "Find the best move" would claim one right answer; right means within 5% of the best.
    for (const focus of [{ kind: 'clock' as const }, { kind: 'leak' as const, key: 'middlegame' as const }]) {
      const view = v4(toReportView(spikeReport({ focus }), { positions: [board()] }));
      expect(view.focus.positions[0].prompt).toBe('Find a better move here.');
    }
    expect(v4(toReportView(spikeReport(), { positions: [board()] })).focus.positions[0].prompt).toBe(
      "You're winning here. Find the move that keeps it.",
    );
  });

  it('noGamesHeroNamesNoLeak', () => {
    // Nothing given away (no games yet): no "biggest leak … 0%".
    const zero = spikeReport({
      games: 0,
      leaks: spikeReport().leaks.map((l) => ({ ...l, sharePct: 0, shareRange: [0, 0] as [number, number] })),
      focus: { kind: 'leak', key: 'middlegame' },
    });
    expect(v4(toReportView(zero)).hero).toEqual({ headline: 'Not enough games yet to say where your points go.', sub: '' });
  });

  it('reportCarriesDrillRefs', () => {
    const query = { timeClass: 'blitz', accounts: [{ username: 'alice', maxGames: 300 }, { username: 'alice2', maxGames: 600 }], maxGames: 300 };
    const view = v4(toReportView(spikeReport(), { quickFixes: [quickFixFromPosition(position(), false)], query }));
    // Each bar opens its own situation, the hero the focus's source, a quick fix its position.
    expect(view.leaks.map((l) => l.key)).toEqual(['middlegame', 'winning', 'opening', 'clock', 'losing', 'endgame']);
    expect(view.hero.source).toBe('thrownWins');
    expect(view.quickFixes?.[0].key).toBe('r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq -');
    expect(view.query).toEqual(query);
    expect(parseCoachView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    // The hero's source follows the focus; a card that names no leak has none.
    expect(v4(toReportView(spikeReport({ focus: { kind: 'clock' } }))).hero.source).toBe('clock');
    expect(v4(toReportView(spikeReport({ focus: { kind: 'leak', key: 'opening' } }))).hero.source).toBe('opening');
    const zero = spikeReport({ leaks: spikeReport().leaks.map((l) => ({ ...l, sharePct: 0 })), focus: { kind: 'leak', key: 'middlegame' } });
    expect('source' in v4(toReportView(zero)).hero).toBe(false);
    // Optional when parsing (an older payload still shows), checked when present.
    const old = { ...view, hero: { headline: view.hero.headline, sub: view.hero.sub }, leaks: view.leaks.map(({ key: _k, ...l }) => l), query: undefined };
    expect(parseCoachView(JSON.parse(JSON.stringify(old)))).not.toBeNull();
    for (const bad of [
      { ...view, hero: { ...view.hero, source: 'everything' } },
      { ...view, leaks: [{ ...view.leaks[0], key: 'rook' }, ...view.leaks.slice(1)] },
      { ...view, quickFixes: [{ ...view.quickFixes![0], key: 7 }] },
      { ...view, query: { accounts: [] } },
      { ...view, query: { timeClass: 'blitz', accounts: [{ username: 'alice', maxGames: 0 }] } },
      { ...view, query: { timeClass: 'blitz', usernames: 'alice' } },
      { ...view, query: { timeClass: 'blitz', asOf: 'yesterday' } },
    ]) {
      expect(parseCoachView(bad), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
    // The refs carry no answers: the quick fix still hides its best move.
    expect(view.quickFixes?.[0]).toMatchObject({ revealed: false, bestSan: null, bestUci: null });
  });

  it('parseReturnsSanitisedReportCopy', () => {
    const clean = v4(toReportView(spikeReport(), { positions: [board()], quickFixes: [quick(false)], cta: 'Go' }));
    const dirty = {
      ...clean,
      extra: 'top',
      hero: { ...clean.hero, tooltip: 'x' },
      leaks: clean.leaks.map((l, i) => (i === 0 ? { ...l, note: 'y' } : l)),
      focus: { ...clean.focus, secret: 'z' },
    };
    const parsed = parseCoachView(JSON.parse(JSON.stringify(dirty)));
    expect(parsed).toEqual(clean); // unknown keys never survive, at any level
    expect(JSON.stringify(parsed)).not.toMatch(/tooltip|note|secret|extra/);
    expect(parsed).not.toBe(dirty); // a copy
  });
});
