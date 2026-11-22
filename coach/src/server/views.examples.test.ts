import { describe, expect, it } from 'vitest';
import type { Outcome } from '../../../src/types';
import type { CachedGame } from '../analysis/cache';
import { examplesPage, type ExamplesPage } from '../diagnosis/examples';
import { fixtureGame, shuffleSans } from '../diagnosis/testGames';
import { parseCoachView, parseExamplesView } from './views';

// Made-up games (alice v bob), built through the real examples module so the parser is checked
// against the server's own shape. Chess.com-style ids so the game link survives the check.
const SANS = shuffleSans(60);
function game(n: number, at: Record<number, number>, outcome: Outcome = 'loss'): CachedGame {
  let w = 50;
  const wins = SANS.map((_, i) => (w = at[i] ?? w));
  const c = fixtureGame({ id: `https://www.chess.com/game/live/${1000 + n}`, sans: SANS, wins, endTime: 1_700_000_000 + n * 1000 });
  return { ...c, game: { ...c.game, outcome, opponent: { username: 'bob', rating: 1400 + n } } };
}
const GAMES = Array.from({ length: 14 }, (_, n) => game(n, { 5: 85, [20 + n]: 40 }));

function realPage(req: Parameters<typeof examplesPage>[2]): ExamplesPage {
  const p = examplesPage(GAMES, ['alice'], req);
  if ('error' in p) throw new Error(p.error);
  return JSON.parse(JSON.stringify(p)); // as it crosses the wire
}

describe('examples view (coach_examples structuredContent)', () => {
  it('examplesViewRoundTrips', () => {
    const page = realPage({ source: 'thrownWins' });
    expect(page.examples).toHaveLength(10);
    expect(page.total).toBe(14);
    // A well-formed page parses to an equal, separate copy, through both entry points.
    const parsed = parseExamplesView(page);
    expect(parsed).toEqual(page);
    expect(parsed).not.toBe(page);
    expect(parseCoachView(page)).toEqual(page);
    // The last page, a quick fix page (with its key) and an empty page past the end parse too.
    expect(parseExamplesView(realPage({ source: 'thrownWins', offset: 10 }))?.examples).toHaveLength(4);
    expect(parseExamplesView(realPage({ source: 'thrownWins', offset: 40 }))?.examples).toEqual([]);
    const fix = { ...page, source: 'quickFix', key: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -', title: 'Games that reached this position' };
    expect(parseExamplesView(fix)).toEqual(fix);
    const row = page.examples[0];
    expect(row).toMatchObject({ result: 'loss', myColor: 'white', opponentRating: 1413, gameUrl: 'https://www.chess.com/game/live/1013', date: '2023-11-15' });

    // Harmless unknown fields are dropped (at the page and in a row), not passed on.
    const extra = { ...page, note: 'hi', examples: [{ ...row, opening: 'Sicilian' }, ...page.examples.slice(1)] };
    const clean = parseExamplesView(extra);
    expect(clean).toEqual(page);
    expect(JSON.stringify(clean)).not.toMatch(/note|opening|Sicilian/);

    // A game link that isn't Chess.com (it goes to openLink) is dropped to null, the row kept.
    const elsewhere = { ...page, examples: [{ ...row, gameUrl: 'javascript:alert(1)' }, { ...row, gameUrl: 'https://evil.test/x' }] };
    expect(parseExamplesView(elsewhere)?.examples.map((e) => e.gameUrl)).toEqual([null, null]);
    expect(parseExamplesView({ ...page, examples: [{ ...row, gameUrl: null }] })?.examples[0].gameUrl).toBeNull();

    // Anything malformed is refused (the panel then says it couldn't read the games).
    const bad: unknown[] = [
      { ...page, kind: 'report' },
      { ...page, source: 'everything' },
      { ...page, title: '' },
      { ...page, numbersLabel: 'deep check' },
      { ...page, limit: 11 },
      { ...page, limit: 0 },
      { ...page, total: 3 }, // fewer than the rows shown
      { ...page, offset: -1 },
      { ...page, source: 'quickFix' }, // a quick fix page needs its key
      { ...page, examples: [...page.examples, row] }, // more rows than the limit
      { ...page, examples: [{ ...row, slipIndex: row.timeline.length }] },
      { ...page, examples: [{ ...row, timeline: [] }] },
      { ...page, examples: [{ ...row, timeline: Array.from({ length: 81 }, () => 50), slipIndex: 0 }] },
      { ...page, examples: [{ ...row, timeline: [...row.timeline.slice(0, -1), 101] }] },
      { ...page, examples: [{ ...row, quickWinBefore: -2 }] },
      { ...page, examples: [{ ...row, fenBefore: 'not a fen' }] },
      { ...page, examples: [{ ...row, playedSan: 'Qz9' }] },
      { ...page, examples: [{ ...row, playedUci: 'e2' }] },
      { ...page, examples: [{ ...row, result: 'lost' }] },
      { ...page, examples: [{ ...row, myColor: 'red' }] },
      { ...page, examples: [{ ...row, date: '21/11/2026' }] },
      { ...page, examples: [{ ...row, opponentRating: '1400' }] },
      { ...page, examples: [{ ...row, slipMoveNo: 0 }] },
      { ...page, examples: [{ ...row, gameId: '' }] },
      { ...page, examples: 'none' },
    ];
    for (const b of bad) expect(parseExamplesView(b), JSON.stringify(b).slice(0, 90)).toBeNull();
  });

  it('examplesCarryNoAnswers', () => {
    const page = realPage({ source: 'thrownWins', limit: 2 });
    const row = page.examples[0];
    // The parsed copy has exactly the contract's fields: no best move, no line, no answer.
    const parsed = parseExamplesView(page)!;
    expect(Object.keys(parsed).sort()).toEqual(['examples', 'kind', 'limit', 'numbersLabel', 'offset', 'source', 'title', 'total']);
    expect(Object.keys(parsed.examples[0]).sort()).toEqual(
      ['date', 'fenBefore', 'gameId', 'gameUrl', 'myColor', 'opponentRating', 'playedSan', 'playedUci', 'quickWinAfter', 'quickWinBefore', 'result', 'slipIndex', 'slipMoveNo', 'slipPly', 'timeline'].sort(),
    );
    // A field named like an answer anywhere refuses the whole page (it is not quietly kept or dropped).
    const answerish: Record<string, unknown>[] = [
      { bestSan: 'Nf3' },
      { bestUci: 'g1f3' },
      { best: 'Nf3' },
      { bestMove: 'Nf3' },
      { answer: 'Nf3' },
      { answerSan: 'Nf3' },
      { line: ['Nf3', 'Nc6'] },
      { bestLineSan: ['Nf3'] },
      { engineLine: 'Nf3 Nc6' },
      { lines: [] },
      { refutationSan: ['Nc6'] },
      { pv: 'Nf3' },
    ];
    for (const a of answerish) {
      expect(parseExamplesView({ ...page, examples: [{ ...row, ...a }] }), `row ${Object.keys(a)[0]}`).toBeNull();
      expect(parseExamplesView({ ...page, ...a }), `page ${Object.keys(a)[0]}`).toBeNull();
      expect(parseCoachView({ ...page, examples: [{ ...row, ...a }] }), `coach ${Object.keys(a)[0]}`).toBeNull();
    }
    // Nested deeper still counts.
    expect(parseExamplesView({ ...page, meta: { hint: { bestSan: 'Nf3' } } })).toBeNull();
    // "timeline" is the one field that ends in "line", and it is the win % curve, not a move line.
    expect(parseExamplesView(page)?.examples[0].timeline).toEqual(row.timeline);
  });
});
