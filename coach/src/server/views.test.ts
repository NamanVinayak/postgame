import { describe, expect, it } from 'vitest';
import type { PositionFacts } from '../coaching/positionFacts';
import {
  parseCoachView,
  toAnswerView,
  toQuestionView,
  toReportView,
  type DiagnosisLike,
  type ReportLabel,
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
const LABELS: ReportLabel[] = ['gap', 'notYourProblem', 'noClearDifference', 'notEnoughData'];

type Area = DiagnosisLike['areas'][number];
function area(over: Partial<Area> & Pick<Area, 'area' | 'label'>): Area {
  return { myRate: 6, oppRate: 6, gapPts: 0, ci95: [-1, 1], games: 120, ...over };
}

function diagnosis(areas: Area[], focus: DiagnosisLike['focus'] = null): DiagnosisLike {
  return { timeClass: 'blitz', games: 300, areas, focus };
}

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

describe('toReportView', () => {
  it('reportViewCapsAtSixRowsPlainLabels', () => {
    const d = diagnosis(
      [
        area({ area: 'opening', label: 'notYourProblem', ci95: [-2, 0.5] }),
        area({ area: 'middlegame', label: 'noClearDifference', ci95: [-0.5, 3] }),
        area({ area: 'endgame', label: 'gap', myRate: 9.1, oppRate: 5.2, gapPts: 3.9, ci95: [2.1, 5.8], ciAdj: [1.2, 6.6] }),
        area({ area: 'converting', label: 'notEnoughData', games: 12 }),
        area({ area: 'defending', label: 'notYourProblem', ci95: [-1.5, 1.2] }),
        area({ area: 'timePressure', label: 'gap', myRate: 14, oppRate: 9, gapPts: 5, ci95: [2.4, 7.7], ciAdj: [0.6, 9.4] }),
        area({ area: 'queenEndgames', label: 'notEnoughData', games: 4 }),
        area({ area: 'rookEndgames', label: 'noClearDifference', ci95: [-0.8, 2.9] }),
      ],
      { kind: 'area', area: 'endgame' },
    );
    const view = toReportView(d, 'Endgames are where your games slip.');
    expect(view.kind).toBe('report');
    if (view.kind !== 'report') return;
    expect(view.rows.length).toBeLessThanOrEqual(6);
    for (const row of view.rows) {
      expect(LABELS).toContain(row.label);
      expect(row.area).toMatch(/^[A-Z][a-z' ]+$/); // plain words, never a camelCase key
    }
    // The cap never drops a weak spot: gap rows come first, biggest sure gap first.
    expect(view.rows.slice(0, 2).map((r) => r.label)).toEqual(['gap', 'gap']);
    expect(view.rows[0].area).toBe('Endgames');
    expect(view.rows[1].area).toBe('Low on the clock');
    // What gets cut is the least informative: the two not-enough-data rows.
    expect(view.rows).toHaveLength(6);
    expect(view.rows.filter((r) => r.label === 'notEnoughData')).toHaveLength(0);
    expect(view.headline).toBe('Endgames are where your games slip.');
    expect(view.games).toBe(300);
    expect(view.timeClass).toBe('blitz');
    expect(JSON.stringify(view)).not.toMatch(/\bci\b|ci95|ciAdj|bootstrap|p-value|confidence/i);
  });

  it('reportViewRangeIsYourLikelyRate', () => {
    const d = diagnosis([
      // ciAdj (the interval that decides "gap") wins over ci95.
      area({ area: 'endgame', label: 'gap', myRate: 9.14, oppRate: 5.21, gapPts: 3.93, ci95: [2.1, 5.8], ciAdj: [1.2, 6.6] }),
      // Without ciAdj the 95% range is used; the low end can't go below 0%.
      area({ area: 'opening', label: 'notYourProblem', myRate: 1.5, oppRate: 2, gapPts: -0.5, ci95: [-3, 0.4] }),
      area({ area: 'converting', label: 'notEnoughData', myRate: 30, oppRate: 0, games: 3 }),
    ]);
    const view = toReportView(d, 'h');
    if (view.kind !== 'report') throw new Error('not a report');
    const [endgame, opening, converting] = view.rows;
    expect(endgame).toEqual({ area: 'Endgames', label: 'gap', you: 9.1, them: 5.2, range: [6.4, 11.8], games: 120 });
    expect(opening).toEqual({ area: 'Openings', label: 'notYourProblem', you: 1.5, them: 2, range: [0, 2.4], games: 120 });
    // Too few games: no numbers are shown, only the game count.
    expect(converting).toEqual({ area: "When you're ahead", label: 'notEnoughData', you: null, them: null, range: null, games: 3 });
  });

  it('reportViewFocusInPlainWords', () => {
    const one = [area({ area: 'endgame', label: 'gap', ci95: [1, 3], ciAdj: [0.5, 4] })];
    const byArea = toReportView(diagnosis(one, { kind: 'area', area: 'converting' }), 'h');
    const byRepeated = toReportView(diagnosis(one, { kind: 'repeated', keys: ['a', 'b', 'c'] }), 'h');
    const single = toReportView(diagnosis(one, { kind: 'repeated', keys: ['a'] }), 'h');
    const none = toReportView(diagnosis(one, null), 'h');
    expect(byArea.kind === 'report' && byArea.focus).toBe("finishing off games when you're ahead");
    expect(byRepeated.kind === 'report' && byRepeated.focus).toBe('the 3 positions you keep getting wrong');
    expect(single.kind === 'report' && single.focus).toBe('the position you keep getting wrong');
    expect(none.kind === 'report' && none.focus).toBeNull();
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

describe('toReportView with focus positions', () => {
  const d = diagnosis([area({ area: 'endgame', label: 'notYourProblem', ci95: [-1, 0.5] })], {
    kind: 'repeated',
    keys: ['a', 'b', 'c'],
  });

  it('reportViewStillWorksWithoutPositions', () => {
    for (const view of [toReportView(d, 'h'), toReportView(d, 'h', {})]) {
      if (view.kind !== 'report') throw new Error('not a report');
      // No new keys appear when the caller passes none, so old callers see the old shape.
      expect(Object.keys(view).sort()).toEqual(['focus', 'games', 'headline', 'kind', 'rows', 'timeClass']);
      expect(parseCoachView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    }
  });

  it('reportViewAcceptsPositionsUpToThree', () => {
    const four = [
      position(),
      position({ wrongUci: null, opening: null }),
      position({ fen: 'r1bqkbnr/pp3ppp/2n5/3pp3/3P4/2PB4/PP3PPP/RNBQK1NR w KQkq - 0 6', orientation: 'white', wrongSan: ['h3'], wrongUci: 'h2h3', bestSan: 'dxe5', bestUci: 'd4e5', lossPts: 21.386, wrongTimes: 3, seenTimes: 3, drillsDone: 3 }),
      position({ bestSan: 'Be7' }), // the fourth is dropped
    ];
    const view = toReportView(d, 'Your rating is honest.', {
      subhead: 'Against players at your rating, no part of your game stands out.',
      positions: four,
      cta: "Start this week's training",
    });
    if (view.kind !== 'report') throw new Error('not a report');
    expect(view.subhead).toBe('Against players at your rating, no part of your game stands out.');
    expect(view.cta).toBe("Start this week's training");
    expect(view.positions).toHaveLength(3);
    expect(view.positions?.map((p) => p.bestSan)).toEqual(['Nf6', 'Nf6', 'dxe5']);
    // Win-chance loss rounded to one decimal, like the rows; everything else as given.
    expect(view.positions?.[0]).toEqual({ ...position(), lossPts: 13.6 });
    expect(view.positions?.[1].wrongUci).toBeNull();
    expect(view.positions?.[1].opening).toBeNull();
    expect(view.positions?.[2].lossPts).toBe(21.4);
    expect(parseCoachView(JSON.parse(JSON.stringify(view)))).toEqual(view);
  });

  it('reportViewRejectsBadPosition', () => {
    const good = toReportView(d, 'h', { positions: [position()], subhead: 's', cta: 'Go' });
    if (good.kind !== 'report') throw new Error('not a report');
    expect(parseCoachView(good)).toEqual(good);

    const bad: Record<string, unknown>[] = [
      { fen: 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP b KQkq - 0 5' }, // 7 ranks
      { fen: 'r1bqkbnr/pp1p1ppp/2n1p3/9/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5' }, // a rank of 9 squares
      { fen: 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R x KQkq - 0 5' }, // no side to move
      { fen: 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5 <script>' },
      { orientation: 'b' },
      { wrongSan: [] },
      { wrongSan: ['g6', 'd5', 'e5', 'a6', 'h6'] }, // more than four
      { wrongSan: ['g6', 7] },
      { wrongSan: ['<b>g6</b>'] },
      { wrongUci: 'g7g9' },
      { wrongUci: 'g6' },
      { bestUci: 'Nf6' },
      { bestUci: null },
      { bestSan: '' },
      { lossPts: Number.NaN },
      { lossPts: Number.POSITIVE_INFINITY },
      { lossPts: -2 },
      { lossPts: '14' },
      { wrongTimes: 10, seenTimes: 9 }, // wrong more often than seen
      { wrongTimes: 1.5 },
      { seenTimes: 0, wrongTimes: 0 },
      { drillsDone: 4, drillsTotal: 3 },
      { drillsDone: -1 },
      { drillsTotal: 2.5 },
      { opening: 5 },
    ];
    for (const over of bad) {
      const view = { ...good, positions: [{ ...position(), ...over }] };
      expect(parseCoachView(view), JSON.stringify(over)).toBeNull();
      // The mapper never emits what the widget would refuse: a bad position is dropped, the rest stay.
      const mapped = toReportView(d, 'h', { positions: [{ ...position(), ...over } as ReportPosition, position()] });
      if (mapped.kind !== 'report') throw new Error('not a report');
      expect(mapped.positions, JSON.stringify(over)).toEqual([{ ...position(), lossPts: 13.6 }]);
      expect(parseCoachView(JSON.parse(JSON.stringify(mapped)))).toEqual(mapped);
    }
    // Report-level fields.
    for (const over of [
      { positions: [position(), position(), position(), position()] }, // more than three
      { positions: 'none' },
      { subhead: 3 },
      { cta: '' },
      { cta: 'x'.repeat(61) },
    ]) {
      expect(parseCoachView({ ...good, ...over }), JSON.stringify(over).slice(0, 80)).toBeNull();
    }
    // A button label the widget would refuse is left out (the widget's default applies), so the card still shows.
    for (const cta of ['', '   ', 'x'.repeat(61)]) {
      const mapped = toReportView(d, 'h', { positions: [position()], cta });
      if (mapped.kind !== 'report') throw new Error('not a report');
      expect(mapped.cta, JSON.stringify(cta)).toBeUndefined();
      expect(parseCoachView(JSON.parse(JSON.stringify(mapped)))).toEqual(mapped);
    }
  });
});

describe('parseCoachView', () => {
  it('acceptsEveryMapperOutput', () => {
    const report = toReportView(diagnosis([area({ area: 'endgame', label: 'gap', ci95: [1, 3] })]), 'h');
    for (const view of [toAnswerView(facts()), toQuestionView(facts(), PROMPT), report]) {
      expect(parseCoachView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    }
  });

  it('rejectsMalformedViews', () => {
    const answer = toAnswerView(facts());
    const question = toQuestionView(facts(), PROMPT);
    const report = toReportView(diagnosis([area({ area: 'endgame', label: 'gap', ci95: [1, 3] })]), 'h');
    const bad: unknown[] = [
      null,
      'answer',
      { ...answer, kind: undefined }, // a bare BoardView without kind
      { ...answer, orientation: 'w' },
      { ...answer, bestLineSan: ['Bc5', 3] },
      { ...question, ply: '5' },
      { ...question, kind: 'quiz' },
      { ...report, rows: [{ ...(report.kind === 'report' ? report.rows[0] : {}), label: 'weak' }] },
      { ...report, rows: [{ ...(report.kind === 'report' ? report.rows[0] : {}), label: 'toString' }] },
      { ...report, rows: [{ ...(report.kind === 'report' ? report.rows[0] : {}), range: [1] }] },
      { ...report, rows: Array.from({ length: 7 }, () => (report.kind === 'report' ? report.rows[0] : {})) },
    ];
    for (const x of bad) expect(parseCoachView(x)).toBeNull();
  });
});
