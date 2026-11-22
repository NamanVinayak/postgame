import { describe, expect, it } from 'vitest';
import type { AreaFinding, Diagnosis } from '../diagnosis/diagnose';
import type { Leak, LeakKey, LeakReport } from '../diagnosis/leaks';
import { areaContext, focusTitle, hasLeakFocus, leakDiagnosisText, leakDiagnosisView } from './leakText';

// Shaped like the 900-game real check (fixture numbers, not anyone's games).
const leak = (key: LeakKey, label: string, sharePct: number, range: [number, number], big: number): Leak => ({
  key, label, sharePct, shareRange: range, bigMistakesPerGame: big, givenAwayPer10: 1, oppGivenAwayPer10: 1, moves: 100,
});
function report(over: Partial<LeakReport> = {}): LeakReport {
  return {
    usernames: ['alice', 'alice2'],
    timeClass: 'blitz',
    games: 900,
    asOf: 0,
    avgScore: 0.489,
    leaks: [
      leak('middlegame', 'Balanced middlegames', 34.8, [33.1, 36.5], 1.79),
      leak('winning', "When you're already winning", 24.4, [22.6, 26.2], 0.95),
      leak('opening', 'Your first 10 moves', 20.5, [19.6, 21.7], 0.82),
      leak('clock', 'Low on the clock', 9.7, [8.2, 11.3], 0.35),
      leak('losing', "When you're already losing", 6.8, [6.2, 7.5], 0.21),
      leak('endgame', 'Endgames', 3.7, [2.9, 4.5], 0.18),
    ],
    conversion: {
      winningGames: 493, won: 338, drawn: 13, lost: 142, convertedPct: 68.56, lostShareOfLossesPct: 31.7,
      lostShareRange: [27.2, 36.1], oppWinningGames: 553, oppConvertedPct: 68.9,
    },
    timeLosses: { losses: 448, onTime: 72, sharePct: 16.07 },
    rangesReliable: true,
    whatIf: { label: 'Rough estimate: if you lost half as many of the games you were winning', extraScorePerGame: 0.0789, ratingPoints: 55 },
    focus: { kind: 'keepTheWin' },
    notes: [
      'Based on 900 games of yours. "Given away" is how much your winning chances dropped with each of your moves.',
      'Clearly winning means your winning chances were at least 75% before 2 of your moves in a row.',
      'For context: when your opponents were clearly winning, they won 69% of those games; you won 69% of yours.',
      'The rating figure is a rough estimate from results alone.',
    ],
    ...over,
  };
}

const area = (over: Partial<AreaFinding> & Pick<AreaFinding, 'area' | 'label'>): AreaFinding => ({
  myRate: 6, oppRate: 5, gapPts: 1, ci95: [-1, 3], ciAdj: [-2, 4], exactP: 0.5, games: 300, myGames: 300, oppGames: 300,
  myMoves: 900, oppMoves: 900, notes: [], ...over,
});
const diag = (areas: AreaFinding[], focus: Diagnosis['focus'] = null, games = 900): Diagnosis => ({
  usernames: ['alice'], timeClass: 'blitz', games, asOf: 0, areas, repeated: [], focus, notes: [],
});

describe('leakDiagnosisText', () => {
  it('diagnosisTextIsRankedLeaksConversionTimeAndWhatIf', () => {
    const text = leakDiagnosisText(report(), {
      context: 'Against players at your rating (your opponents in the same games), no part of your game stands out (900 games).',
      gamesByAccount: [{ username: 'alice', games: 300 }, { username: 'alice2', games: 600 }],
      repeated: 30,
    });
    expect(text).toContain('900 blitz games');
    expect(text).toContain('Games per account: alice 300, alice2 600.');
    // Ranked leaks with share and range, and costly moves per game.
    expect(text).toContain('1. Balanced middlegames: 35% of the winning chances you gave away (likely 33–37%); about 2 costly moves per game.');
    expect(text).toContain('6. Endgames: 4%');
    expect(text.indexOf('Balanced middlegames')).toBeLessThan(text.indexOf("When you're already winning"));
    // Conversion, with "clearly winning" in plain words.
    expect(text).toContain('winning chances of 75% or more on two of your moves in a row');
    expect(text).toContain('in 493 of your 900 games: you won 338, drew 13 and lost 142');
    expect(text).toContain('142 of your 448 losses (32%, likely 27–36%) were games you were clearly winning.');
    expect(text).toContain('72 of your 448 losses (16%) were on time.');
    // The what-if: capped rating points only, always "rough estimate"; never the uncapped score per game.
    expect(text).toMatch(/rough estimate/i);
    expect(text).toContain('+55 rating points');
    expect(text).not.toMatch(/0\.07|0\.08|7\.9|extra score/);
    // The old area table is one context line.
    expect(text).not.toContain('| Area |');
    expect(text.split('\n').filter((l) => /players at your rating/.test(l))).toHaveLength(1);
    expect(text).toContain('Focus this week: Keep the win');
    expect(text).toContain('Positions you keep reaching and getting wrong: 30');
    // Notes the text already says in its own words are not repeated.
    expect(text).not.toContain('Clearly winning means');
    expect(text).not.toContain('For context: when your opponents');
    expect(text).toContain('The rating figure is a rough estimate from results alone.');
  });

  it('rangesHiddenWhenUnreliableAndNoWhatIfWithoutOne', () => {
    const text = leakDiagnosisText(report({ games: 12, rangesReliable: false, whatIf: null, notes: [] }), { context: null, gamesByAccount: [], repeated: 0 });
    expect(text).not.toMatch(/likely \d/);
    expect(text).toContain('Ranges are hidden (not enough data): with fewer than 30 games they are too rough to show.');
    expect(text).not.toMatch(/rough estimate|rating points/i);
    expect(text).not.toContain('Positions you keep reaching');
  });

  it('noGamesSaysSoPlainly', () => {
    const zero = report({
      games: 0,
      leaks: report().leaks.map((l) => ({ ...l, sharePct: 0, shareRange: [0, 0] as [number, number] })),
      conversion: { ...report().conversion, winningGames: 0, won: 0, drawn: 0, lost: 0, lostShareOfLossesPct: 0, oppWinningGames: 0 },
      timeLosses: { losses: 0, onTime: 0, sharePct: 0 },
      whatIf: null,
      focus: { kind: 'leak', key: 'middlegame' },
    });
    expect(hasLeakFocus(zero)).toBe(false);
    const text = leakDiagnosisText(zero, { context: null, gamesByAccount: [], repeated: 0 });
    expect(text).toContain('No focus yet');
    expect(text).not.toMatch(/biggest|Focus this week/);
  });
});

describe('leakDiagnosisView', () => {
  it('structuredCopyCarriesTheCappedWhatIfOnly', () => {
    const v = leakDiagnosisView(report(), { context: 'c', gamesByAccount: [], repeated: [] });
    expect(v.whatIf).toEqual({ label: 'Rough estimate: if you lost half as many of the games you were winning', ratingPoints: 55 });
    expect(JSON.stringify(v)).not.toContain('extraScorePerGame');
    expect(v).toMatchObject({ rangesReliable: true, games: 900, focusTitle: 'Keep the win', context: 'c' });
    expect(leakDiagnosisView(report({ rangesReliable: false }), { context: null, gamesByAccount: [], repeated: [] }).rangesReliable).toBe(false);
  });
});

describe('areaContext and focusTitle', () => {
  it('areaTableBecomesOneLine', () => {
    expect(areaContext(diag([area({ area: 'endgame', label: 'notYourProblem' })]))).toBe(
      'Against players at your rating (your opponents in the same games), no part of your game stands out (900 games).',
    );
    expect(
      areaContext(diag([area({ area: 'endgame', label: 'gap', myRate: 9.4, oppRate: 5.6, games: 141 })], { kind: 'area', area: 'endgame' })),
    ).toBe('Against players at your rating (your opponents in the same games), your endgames stand out: 9.4% of your moves there are serious mistakes, against 5.6% (141 games).');
    expect(areaContext(diag([area({ area: 'endgame', label: 'notEnoughData' })], null, 12))).toBe(
      'Too few games yet to compare you with players at your rating (12 games; each part of the game needs at least 30).',
    );
    expect(areaContext(diag([], null, 0))).toBeNull();
    expect(focusTitle({ kind: 'keepTheWin' })).toBe('Keep the win');
    expect(focusTitle({ kind: 'clock' })).toBe('Beat the clock');
    expect(focusTitle({ kind: 'leak', key: 'opening' })).toBe('Your first 10 moves');
  });
});
