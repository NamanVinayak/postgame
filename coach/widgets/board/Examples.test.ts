import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  parseExamplesView,
  toReportView,
  type ExampleRowView,
  type ExamplesView,
  type LeakReportLike,
  type QuickFix,
  type ReportQuery,
  type ReportView,
} from '../../src/server/views';
import {
  ExamplesLoader,
  draftTry,
  drillTargets,
  exampleArrows,
  openGame,
  pickQuery,
  showingText,
  slipText,
  sparkGeometry,
  tryText,
  type ExamplesState,
} from './drill';
import { ExamplesPanelView, Sparkline } from './ExamplesPanel';
import { ReportCard } from './ReportCard';

// ---- Fixtures (made-up games; numbers are fixture values, not engine output) ----

const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const row = (n: number, over: Partial<ExampleRowView> = {}): ExampleRowView => ({
  gameId: `https://www.chess.com/game/live/${9000 + n}`,
  gameUrl: `https://www.chess.com/game/live/${9000 + n}`,
  date: '2026-11-21',
  opponentRating: 1083,
  result: 'loss',
  myColor: 'black',
  slipPly: 45,
  slipMoveNo: 23,
  fenBefore: FEN,
  playedSan: 'Nf6',
  playedUci: 'g8f6',
  quickWinBefore: 82.4,
  quickWinAfter: 29.6,
  timeline: [50, 55, 60, 82.4, 29.6, 20, 10],
  slipIndex: 4,
  ...over,
});
function page(offset: number, count: number, total = 142, over: Partial<ExamplesView> = {}): ExamplesView {
  const p: ExamplesView = {
    kind: 'examples',
    source: 'thrownWins',
    title: 'Games you were winning and lost',
    total,
    offset,
    limit: 10,
    numbersLabel: 'quick check',
    examples: Array.from({ length: count }, (_, i) => row(offset + i)),
    ...over,
  };
  expect(parseExamplesView(JSON.parse(JSON.stringify(p)))).not.toBeNull(); // fixtures are well formed
  return p;
}
/** Static markup with the entities React escapes turned back, so tests read the words. */
const words = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const reply = (structuredContent: unknown) => ({ content: [{ type: 'text', text: 'rows' }], structuredContent });

/** A stand-in for the MCP Apps App: records what the widget asks the host for. */
function fakeApp(replies: unknown[] = []) {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const messages: unknown[] = [];
  const links: unknown[] = [];
  return {
    calls,
    messages,
    links,
    callServerTool: async (p: { name: string; arguments?: Record<string, unknown> }) => {
      calls.push(p);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return r as never;
    },
    sendMessage: async (p: unknown) => {
      messages.push(p);
      return {};
    },
    openLink: async (p: unknown) => {
      links.push(p);
      return {};
    },
  };
}

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
  key: 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq -',
};
const QUERY: ReportQuery = { timeClass: 'blitz', accounts: [{ username: 'alice', maxGames: 300 }, { username: 'alice2', maxGames: 600 }] };
const report = (r: LeakReportLike = SPIKE): ReportView => toReportView(r, { quickFixes: [TAIMANOV], query: QUERY });
const cardHtml = (view: ReportView) =>
  words(renderToStaticMarkup(createElement(ReportCard, { app: {} as never, view, display: { mode: 'inline', available: [] }, onDisplayMode: () => {} })));
const panelHtml = (state: ExamplesState, over: Partial<Parameters<typeof ExamplesPanelView>[0]> = {}) =>
  words(
    renderToStaticMarkup(
      createElement(ExamplesPanelView, { app: fakeApp() as never, state, onBack: () => {}, onMore: () => {}, onRetry: () => {}, ...over }),
    ),
  );
const ready = async (p: ExamplesView) => {
  const loader = new ExamplesLoader(fakeApp([reply(p)]) as never, { source: p.source, key: p.key }, QUERY);
  await loader.load();
  return loader.getState();
};

// ---- Tests ----

describe('drill-down: what opens what', () => {
  it('clickingABarCallsCoachExamplesWithItsKeyAndTheQuery', async () => {
    const view = report();
    const t = drillTargets(view);
    expect(t.hero).toEqual({ source: 'thrownWins' });
    expect(t.bars).toEqual([{ source: 'middlegame' }, { source: 'winning' }, { source: 'clock' }]);
    expect(t.fixes).toEqual([{ source: 'quickFix', key: TAIMANOV.key }]);

    // The card draws each of them as a real button, tagged with what it opens.
    const html = cardHtml(view);
    for (const id of ['hero', 'bar-0', 'bar-1', 'bar-2', 'fix-0']) expect(html).toMatch(new RegExp(`<button[^>]*data-drill="${id}"`));
    expect(html).toContain('Tap a bar to see examples from your games.');

    // A bar's button opens a loader for its ref; its first call is coach_examples with the report's query.
    const app = fakeApp([reply(page(0, 10))]);
    const loader = new ExamplesLoader(app as never, t.bars[1]!, view.query);
    await loader.load();
    expect(app.calls).toEqual([
      { name: 'coach_examples', arguments: { source: 'winning', offset: 0, limit: 10, timeClass: 'blitz', accounts: QUERY.accounts } },
    ]);
    // A quick fix passes its key.
    const fixApp = fakeApp([reply(page(0, 3, 9, { source: 'quickFix', key: TAIMANOV.key, title: 'Games that reached this position' }))]);
    await new ExamplesLoader(fixApp as never, t.fixes[0]!, view.query).load();
    expect(fixApp.calls[0].arguments).toEqual({ source: 'quickFix', key: TAIMANOV.key, offset: 0, limit: 10, timeClass: 'blitz', accounts: QUERY.accounts });
  });

  it('olderPayloadStaysStatic', () => {
    // No refs (a card from before the drill-down): nothing is clickable, nothing claims it is.
    const v = report();
    const old: ReportView = {
      ...v,
      hero: { headline: v.hero.headline, sub: v.hero.sub },
      leaks: v.leaks.map(({ key: _k, ...l }) => l),
      quickFixes: v.quickFixes!.map(({ key: _k, ...q }) => q),
    };
    expect(drillTargets(old)).toEqual({ hero: null, bars: [null, null, null], fixes: [null] });
    const html = cardHtml(old);
    expect(html).not.toContain('data-drill');
    expect(html).not.toContain('Tap a bar');
    expect(html).not.toContain('See examples');
  });

  it('heroCueNeverClaimsTheHerosNumber', () => {
    // The clock hero counts losses on time; its list is costly moves made low on the clock.
    const clock = cardHtml(report({ ...SPIKE, focus: { kind: 'clock' } }));
    const hero = /<button[^>]*data-drill="hero"[^>]*>(.*?)<\/button>/.exec(clock)?.[1] ?? '';
    expect(hero).toContain('72 of your 448 losses were on time.');
    expect(hero).toContain('See examples from your games');
    expect(hero).not.toMatch(/see (the|these|all) \d|see the 72|on-time losses/i);
    // The panel's heading is the page's own title.
    const title = 'Low on the clock: your costliest move in each game';
    expect(panelHtml({ phase: 'ready', title, source: 'clock', total: 137, start: 0, rows: [row(0)], more: 'idle' })).toMatch(
      new RegExp(`<h2[^>]*>${title}</h2>`),
    );
  });

  it('winningChancesEverywhere', () => {
    const html = cardHtml(report({ ...SPIKE, focus: { kind: 'leak', key: 'winning' } }));
    expect(html).toContain('24% of the winning chances you give away happen here.');
    expect(html).not.toMatch(/win chance\b/);
  });
});

describe('the examples panel', () => {
  it('moreAppendsAndTheCountUpdates', async () => {
    const app = fakeApp([reply(page(0, 10)), reply(page(10, 10))]);
    const loader = new ExamplesLoader(app as never, { source: 'thrownWins' }, QUERY);
    const seen: string[] = [];
    loader.subscribe(() => seen.push(loader.getState().phase));
    expect(loader.getState().phase).toBe('loading');
    await loader.load();
    let s = loader.getState();
    expect(s.phase === 'ready' && showingText(s)).toBe('Showing 1–10 of 142');
    expect(panelHtml(s)).toContain('Showing 1–10 of 142');
    expect(panelHtml(s)).toMatch(/<button[^>]*class="rc-more"[^>]*>More<\/button>/);

    await loader.more();
    expect(app.calls[1].arguments).toMatchObject({ source: 'thrownWins', offset: 10, limit: 10, timeClass: 'blitz' });
    s = loader.getState();
    expect(s.phase === 'ready' && s.rows.map((r) => r.gameId.slice(-4))).toEqual(Array.from({ length: 20 }, (_, i) => String(9000 + i)));
    expect(panelHtml(s)).toContain('Showing 1–20 of 142');
    expect(seen).toContain('ready');

    // The last page: no More.
    const last = await ready(page(0, 3, 3));
    expect(last.phase === 'ready' && showingText(last)).toBe('Showing 1–3 of 3');
    expect(panelHtml(last)).not.toContain('rc-more');
    // A standalone page shown by the model starts where it starts; without its query there is no More.
    const solo = new ExamplesLoader(fakeApp() as never, { source: 'thrownWins' }, undefined, page(10, 10));
    const ss = solo.getState();
    expect(ss.phase === 'ready' && showingText(ss)).toBe('Showing 11–20 of 142');
    expect(solo.canMore).toBe(false);
    expect(panelHtml(ss, { onMore: undefined, onBack: undefined })).not.toContain('rc-more');
    expect(panelHtml(ss, { onMore: undefined, onBack: undefined })).not.toContain('Back to report');
    expect(panelHtml(ss)).toContain('Back to report');
  });

  it('errorsAndWaitingInPlainWords', async () => {
    const cases: [unknown, RegExp][] = [
      [new Error('socket closed'), /Couldn't reach the coach/],
      [{ isError: true, content: [{ type: 'text', text: 'No position you keep reaching has that key' }] }, /Couldn't load these games/],
      [reply({ kind: 'status', title: 'Still analysing your games', message: 'Your games are still being analysed. Ask again in a minute.' }), /still being analysed/],
      [reply({ ...page(0, 1), examples: [{ ...row(0), bestSan: 'Nf3' }] }), /Couldn't read/],
      [reply({ ...page(0, 1), source: 'middlegame', title: 'x' }), /Couldn't read/], // not the page that was asked for
    ];
    for (const [r, want] of cases) {
      const loader = new ExamplesLoader(fakeApp([r]) as never, { source: 'thrownWins' }, QUERY);
      await loader.load();
      const s = loader.getState();
      expect(s.phase, String(want)).toBe('failed');
      if (s.phase === 'failed') expect(s.message).toMatch(want);
      const html = panelHtml(s);
      expect(html).toContain('Try again');
      expect(html).not.toMatch(/socket|coach_report|isError|undefined/);
    }
    // A failed More keeps the rows and says so.
    const loader = new ExamplesLoader(fakeApp([reply(page(0, 10)), new Error('x')]) as never, { source: 'thrownWins' }, QUERY);
    await loader.load();
    await loader.more();
    const s = loader.getState();
    expect(s.phase === 'ready' && [s.rows.length, s.more]).toEqual([10, 'failed']);
    expect(panelHtml(s)).toContain("Couldn't load more games.");
    // A reply that lands after the panel closed changes nothing.
    let release: (v: unknown) => void = () => {};
    const slow = { callServerTool: () => new Promise((r) => (release = r)) };
    const late = new ExamplesLoader(slow as never, { source: 'thrownWins' }, QUERY);
    const done = late.load();
    late.close();
    release(reply(page(0, 10)));
    await done;
    expect(late.getState().phase).toBe('loading');
  });

  it('rowShowsDateRatingResultAndTheSlip', async () => {
    const s = await ready(page(0, 1));
    const html = panelHtml(s);
    expect(slipText(row(0))).toBe('Move 23: 82% → 30% (quick check)');
    expect(html.replace(/<[^>]+>/g, '')).toContain('Move 23: 82% → 30% (quick check)');
    expect(html).toContain('21 Nov 2026');
    expect(html).toContain('vs 1083');
    expect(html).toMatch(/class="rc-chip rc-chip--loss"[^>]*>Loss</);
    const unrated = await ready({ ...page(0, 1), examples: [row(0, { opponentRating: null, result: 'win' })] });
    expect(panelHtml(unrated)).toContain('vs unrated');
    expect(panelHtml(unrated)).toMatch(/rc-chip--win[^>]*>Win</);
  });

  it('tryThisPositionSendsTheExactText', async () => {
    const r = row(0, { gameId: 'https://www.chess.com/game/live/123456789', slipPly: 39 });
    expect(tryText(r)).toBe('Coach me on this position: game https://www.chess.com/game/live/123456789, ply 39');
    const app = fakeApp();
    expect(await draftTry(app as never, r)).toBe('drafted');
    expect(app.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Coach me on this position: game https://www.chess.com/game/live/123456789, ply 39' }] }]);
    // The button says what it does in Claude Desktop (it drafts, the player sends).
    const html = panelHtml(await ready(page(0, 1)));
    expect(html).toMatch(/<button[^>]*>Try this position<\/button>/);
    expect(html).toContain('Puts it in your message box');
    // A host that refuses, throws or has no sendMessage: the player is told what to type.
    for (const bad of [{ sendMessage: async () => ({ isError: true }) }, { sendMessage: async () => { throw new Error('no'); } }, {}]) {
      expect(await draftTry(bad as never, r)).toBe('failed');
    }
  });

  it('nullGameUrlHidesTheLink', async () => {
    const s = await ready({ ...page(0, 2), examples: [row(0), row(1, { gameUrl: null })] });
    const html = panelHtml(s);
    expect(html.match(/>Open on Chess\.com/g) ?? []).toHaveLength(1);
    expect(html.match(/>Try this position</g) ?? []).toHaveLength(2);
    // Opening asks the host; a refusal or a missing openLink is reported, not thrown.
    const app = fakeApp();
    expect(await openGame(app as never, 'https://www.chess.com/game/live/9000')).toBe('opened');
    expect(app.links).toEqual([{ url: 'https://www.chess.com/game/live/9000' }]);
    expect(await openGame({ openLink: async () => ({ isError: true }) } as never, 'https://www.chess.com/game/live/1')).toBe('failed');
    expect(await openGame({} as never, 'https://www.chess.com/game/live/1')).toBe('failed');
  });

  it('slowThrownWinHasNoTryButton', async () => {
    // Lost on time while winning: the biggest drop after winning is under 10 points.
    const slow = row(1, { quickWinBefore: 81, quickWinAfter: 76.2 });
    const s = await ready({ ...page(0, 2), examples: [row(0), slow] });
    const html = panelHtml(s);
    expect(html).toContain('No single costly move in this game (it slipped away slowly or on the clock).');
    expect(html.match(/>Try this position</g) ?? []).toHaveLength(1);
    expect(html.match(/>Open on Chess\.com/g) ?? []).toHaveLength(2);
    // The same small drop from another source keeps its button (a quick fix game, say).
    const fix = await ready({ ...page(0, 1, 9, { source: 'quickFix', key: TAIMANOV.key, title: 'Games that reached this position' }), examples: [slow] });
    expect(panelHtml(fix)).toContain('>Try this position<');
  });

  it('examplesCarryNoAnswers', async () => {
    // The board shows the played move as one red arrow, and only when it was costly (10+ points):
    // a move that lost nothing is never drawn as the mistake, nor shown at all.
    expect(exampleArrows(row(0))).toEqual([{ startSquare: 'g8', endSquare: 'f6', color: expect.stringMatching(/^rgba\(180, 46, 36/) }]);
    expect(exampleArrows(row(0, { quickWinBefore: 52, quickWinAfter: 51 }))).toEqual([]);
    const html = panelHtml(await ready(page(0, 10)));
    expect(html).not.toMatch(/best|answer|27, 110, 62|1b6e3e|rc-good|rc-best/i); // no answer words, no green
    expect(html).toContain('Red arrow: your move in this game, Nf6');
    // The page the widget shows is the parsed copy: an answer-like field never reaches it.
    expect(parseExamplesView({ ...page(0, 1), examples: [{ ...row(0), bestSan: 'Bc5' }] })).toBeNull();
  });
});

describe('sparkline', () => {
  it('sparklineMarksSlip', () => {
    const r = row(0); // timeline [50, 55, 60, 82.4, 29.6, 20, 10], slip at index 4
    const g = sparkGeometry(r.timeline, r.slipIndex, 240, 48, 4);
    expect(g.points.split(' ')).toHaveLength(7);
    expect(g.slip).toEqual({ x: 4 + (4 * 232) / 6, y: 4 + ((100 - 29.6) / 100) * 40 });
    const svg = renderToStaticMarkup(createElement(Sparkline, { timeline: r.timeline, slipIndex: r.slipIndex, moveNo: 23 }));
    // One red mark at the slip, and the drop into it drawn red.
    const marks = [...svg.matchAll(/<circle[^>]*class="rc-sparkSlip"[^>]*>/g)];
    expect(marks).toHaveLength(1);
    expect(marks[0][0]).toContain(`cx="${g.slip.x.toFixed(1)}"`);
    expect(marks[0][0]).toContain(`cy="${g.slip.y.toFixed(1)}"`);
    expect(svg).toContain('class="rc-sparkDrop"');
    expect(svg).toContain('aria-label="Your winning chances through the game. The slip at move 23 is marked in red."');
    const css = readFileSync(new URL('./report.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.rc-sparkSlip \{[^}]*fill: var\(--rc-bad\)/);
    expect(css).toMatch(/\.rc-sparkDrop \{[^}]*stroke: var\(--rc-bad\)/);
    // One point, or none to mark: no division by zero, no NaN.
    const one = sparkGeometry([64], 0, 240, 48, 4);
    expect(one.slip.x).toBe(120);
    expect(renderToStaticMarkup(createElement(Sparkline, { timeline: [64], slipIndex: 0, moveNo: 1 }))).not.toContain('NaN');
  });
});

describe('query for a standalone page', () => {
  it('picksOnlyTheGameFields', () => {
    expect(pickQuery({ source: 'thrownWins', offset: 0, limit: 3, accounts: QUERY.accounts, timeClass: 'blitz', asOf: '2026-11-22', junk: 1 })).toEqual({
      accounts: QUERY.accounts,
      timeClass: 'blitz',
      asOf: '2026-11-22',
    });
    expect(pickQuery({ source: 'thrownWins' })).toEqual({});
    expect(pickQuery(undefined)).toBeUndefined();
  });
});
