import { describe, expect, it } from 'vitest';
import type { PositionFacts } from '../coaching/positionFacts';
import {
  parseCoachView,
  toAnswerView,
  toQuestionView,
  toReportView,
  type DiagnosisLike,
  type ReportLabel,
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
