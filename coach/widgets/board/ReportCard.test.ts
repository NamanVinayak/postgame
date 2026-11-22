import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toReportView, toStatusView, type LeakReportLike, type QuickFix, type ReportV4Extras, type StatusView } from '../../src/server/views';
import { ReportCard } from './ReportCard';
import { StatusCard } from './StatusCard';

// Shaped like the 900-game spike (fixture numbers, not engine output).
const SPIKE: LeakReportLike = {
  timeClass: 'blitz',
  games: 900,
  leaks: [
    { key: 'middlegame', label: 'Balanced middlegames', sharePct: 35, shareRange: [32, 38], bigMistakesPerGame: 1.8 },
    { key: 'winning', label: "When you're already winning", sharePct: 24, shareRange: [21, 27], bigMistakesPerGame: 1.0 },
    { key: 'clock', label: 'Low on the clock', sharePct: 10, shareRange: [7, 13], bigMistakesPerGame: 0.4 },
  ],
  conversion: { winningGames: 493, lost: 142, convertedPct: 69, lostShareOfLossesPct: 31.7, oppConvertedPct: 69 },
  timeLosses: { losses: 448, onTime: 72, sharePct: 16.1 },
  whatIf: { ratingPoints: 55 },
  focus: { kind: 'keepTheWin' },
};
const TAIMANOV: QuickFix = {
  fen: 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5',
  orientation: 'black',
  label: 'Sicilian Defense: Taimanov Variation',
  times: '8 of 9 games',
  wrongSan: ['g6', 'd5'],
  wrongUci: 'g7g6',
  revealed: false,
  bestSan: null,
  bestUci: null,
};

const card = (r: LeakReportLike, extras: ReportV4Extras = {}) =>
  renderToStaticMarkup(
    createElement(ReportCard, {
      app: {} as never,
      view: toReportView(r, extras),
      display: { mode: 'inline', available: [] },
      onDisplayMode: () => {},
    }),
  );

describe('report card v5 look and wording', () => {
  it('rangesHiddenWhenUnreliable', () => {
    const sure = card(SPIKE);
    expect(sure).toContain('rc-leakRange');
    expect(sure).toContain('likely range');
    expect(sure).not.toContain('Too few games to show how sure these numbers are.');

    const shaky = card({ ...SPIKE, rangesReliable: false });
    expect(shaky).not.toContain('rc-leakRange'); // no band on any bar
    expect(shaky).not.toContain('likely range'); // no key for it either
    expect(shaky).toContain('Too few games to show how sure these numbers are.');
    // The bars themselves stay.
    expect(shaky.match(/class="rc-leakFill"/g) ?? []).toHaveLength(3);
  });

  it('barsSpeakOfCostlyMoves', () => {
    const html = card(SPIKE);
    expect(html).toContain('Where your lost winning chances go');
    expect(html).toContain('Share of all the winning chances you gave away');
    expect(html).toContain('About 2 costly moves per game');
    expect(html).toContain('72 of your 448 losses were on time'); // a special line is kept
    expect(html).toContain('Costly move = a move that drops your winning chances by 10% or more (for example from 60% to 48%).');
    expect(html).not.toMatch(/big mistake/i);
  });

  it('quickFixRevealedWithoutAnswerSaysSo', () => {
    const hidden = card(SPIKE, { quickFixes: [TAIMANOV] });
    expect(hidden).toContain('Answer after you try it');
    const noAnswer = card(SPIKE, { quickFixes: [{ ...TAIMANOV, revealed: true }] });
    expect(noAnswer).toContain('Answer not available');
    expect(noAnswer).not.toContain('Answer after you try it');
    const shown = card(SPIKE, { quickFixes: [{ ...TAIMANOV, revealed: true, bestSan: 'Nf6', bestUci: 'g8f6' }] });
    expect(shown).toContain('Nf6');
  });

  it('paperStyleInBothThemes', () => {
    // One paper look whatever the host theme: no dark tokens, no theme overrides, no OS-theme query.
    const css = readFileSync(new URL('./report.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/data-theme|prefers-color-scheme/);
    expect(css).toMatch(/--rc-paper:\s*#f7f4ed/i);
    expect(css).toMatch(/--rc-ink:\s*#16130f/i);
    expect(css).toMatch(/--rc-serif:[^;]*Georgia[^;]*serif;/); // the serif headline, system fonts only
    expect(css).toMatch(/\.rc-heroLine[^}]*\}/); // (the hero sits in .rc-hero, which uses the serif)
    expect(css).toMatch(/\.rc-hero \{[^}]*font-family: var\(--rc-serif\)/);
    expect(css).not.toMatch(/@import|url\(\s*['"]?https?:/); // no external fonts
    // Both cards wear it.
    expect(card(SPIKE)).toMatch(/^<article class="rc"/);
    const status = renderToStaticMarkup(createElement(StatusCard, { view: toStatusView('Analysing your games', 'm', { done: 1, total: 2 }) as StatusView }));
    expect(status).toMatch(/^<article class="rc rc--status"/);
  });
});
