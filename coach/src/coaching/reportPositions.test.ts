import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { evalToWinPct } from '../../../src/analysis/winPct';
import type { Evaluation } from '../../../src/services/engine/types';
import type { CachedGame } from '../analysis/cache';
import { DISPLAY_CFG } from '../config';
import type { Diagnosis } from '../diagnosis/diagnose';
import { positionKey, type RepeatedPosition } from '../diagnosis/repeated';
import { fixtureGame } from '../diagnosis/testGames';
import { createDisplayEngine } from '../engine/displayEngine';
import { buildReportPositions, commonOpening, openingName } from './reportPositions';
import { emptyStudent, recordAttempt, startSession } from './student';

const ev = (cp: number | null, pvUci: string[]): Evaluation => ({ cp, mate: null, bestMoveUci: pvUci[0], secondBest: null, pvUci });

const fenAfter = (sans: string[]) => {
  const b = new Chess();
  for (const s of sans) b.move(s);
  return b.fen();
};
const play = (fen: string, san: string) => new Chess(fen).move(san).after;

function withPgn(c: CachedGame, headers: string): CachedGame {
  c.game.pgn = `${headers}\n\n1. e4 *`;
  return c;
}

const ECO = (slug: string) => `[ECOUrl "https://www.chess.com/openings/${slug}"]`;

describe('openingName', () => {
  it('openingNameFromEcoUrl: a readable name, without the move sequence', () => {
    const cases: [string, string][] = [
      ['Caro-Kann-Defense-Exchange-Variation-3...cxd5-4.Bd3', 'Caro-Kann Defense: Exchange Variation'],
      ['Queens-Gambit-Declined-Exchange-Variation', "Queen's Gambit Declined: Exchange Variation"],
      ['Italian-Game-Two-Knights-Defense', 'Italian Game: Two Knights Defense'],
      ['French-Defense-Advance-Variation...4.c3', 'French Defense: Advance Variation'],
      ['Sicilian-Defense-Smith-Morra-Gambit-Accepted-4.Nxc3', 'Sicilian Defense: Smith-Morra Gambit Accepted'],
      ['Kings-Pawn-Opening-Wayward-Queen-Attack', "King's Pawn Opening: Wayward Queen Attack"],
      ['Bishops-Opening', "Bishop's Opening"],
      ['Pirc-Defense-3.Nc3', 'Pirc Defense'],
    ];
    for (const [slug, name] of cases) expect(openingName(`[Event "Live Chess"]\n${ECO(slug)}\n\n1. e4 *`)).toBe(name);
  });

  it('prefers an [Opening] header, trims its moves too, and is null when there is nothing', () => {
    expect(openingName(`[Opening "Sicilian Defense: Alapin Variation"]\n${ECO('Sicilian-Defense')}`)).toBe(
      'Sicilian Defense: Alapin Variation',
    );
    expect(openingName('[Opening "Sicilian Defense: Closed, 2...Nc6"]')).toBe('Sicilian Defense: Closed');
    expect(openingName('[Event "Live Chess"]\n\n1. e4 *')).toBeNull();
    expect(openingName('[ECOUrl "https://www.chess.com/game/live/1"]')).toBeNull();
  });

  it('commonOpening: the most common family, as specific as all its games agree on', () => {
    expect(commonOpening(['Italian Game: Two Knights Defense', 'Italian Game: Giuoco Piano', 'Ruy Lopez Opening: Morphy Defense'])).toBe(
      'Italian Game',
    );
    expect(commonOpening(['Caro-Kann Defense: Exchange Variation', 'Caro-Kann Defense: Exchange Variation'])).toBe(
      'Caro-Kann Defense: Exchange Variation',
    );
    expect(commonOpening([])).toBeNull();
  });
});

describe('buildReportPositions', () => {
  // P: after 1.e4 e5 2.Nf3 Nc6, White (alice) to move. Usual wrong moves: Bc4 twice, Na3 once.
  const P = fenAfter(['e4', 'e5', 'Nf3', 'Nc6']);
  // Q: after 1.d4 d5. The quick check's "wrong" c4 is the deep best: nothing left to teach.
  const Q = fenAfter(['d4', 'd5']);
  // R: after 1.e4 c5. The deep check clears the usual Nc3 (it loses only about 2%).
  const R = fenAfter(['e4', 'c5']);

  const gA = withPgn(fixtureGame({ id: 'https://example.test/game/A', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'] }), ECO('Italian-Game-Two-Knights-Defense-4.Ng5'));
  const gB = withPgn(fixtureGame({ id: 'https://example.test/game/B', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'] }), ECO('Italian-Game-Giuoco-Piano'));
  const gC = withPgn(fixtureGame({ id: 'https://example.test/game/C', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Na3', 'Nf6'] }), ECO('Ruy-Lopez-Opening-Morphy-Defense'));
  const games = [gA, gB, gC];

  const rep = (fen: string, usual: RepeatedPosition['usual'], over: Partial<RepeatedPosition> = {}): RepeatedPosition => ({
    key: positionKey(fen),
    fen,
    movesFromStart: [],
    seen: 4,
    wrong: 3,
    avgLossPts: 13.6,
    usual,
    best: 'Bb5', // the quick search's best move: must never be used
    gameIds: games.map((c) => c.game.id),
    ...over,
  });

  const d: Diagnosis = {
    usernames: ['alice'],
    timeClass: 'blitz',
    games: 3,
    asOf: 0,
    areas: [],
    repeated: [
      rep(Q, [{ move: 'c4', times: 2, lossPts: 7 }]),
      rep(R, [{ move: 'Nc3', times: 2, lossPts: 8 }]),
      rep(P, [
        { move: 'Bc4', times: 2, lossPts: 9 },
        { move: 'Na3', times: 1, lossPts: 30 },
      ]),
    ],
    focus: { kind: 'repeated', keys: [positionKey(P)] },
    notes: [],
  };

  // White's win % from the deep searches (White to move in P, Q and R; Black to move after).
  const DEEP: Record<string, Evaluation> = {
    [P]: ev(60, ['d2d4', 'e5d4', 'f3d4']), // deep best d4 (the quick check said Bb5)
    [play(P, 'Bc4')]: ev(30, ['f8c5']), // Black +30: White loses about 8%
    [play(P, 'Na3')]: ev(120, ['d7d5']),
    [Q]: ev(30, ['c2c4', 'e7e6']),
    [R]: ev(40, ['g1f3', 'd7d6']),
    [play(R, 'Nc3')]: ev(-20, ['b8c6']), // White still +20: only about 2% lost
  };

  function engine() {
    const calls: { fen: string; ms: number }[] = [];
    const e = createDisplayEngine(() => ({
      async evaluate(fen: string, ms: number) {
        calls.push({ fen, ms });
        const x = DEEP[fen];
        if (!x) throw new Error(`unexpected search: ${fen}`);
        return x;
      },
    }));
    return { e, calls };
  }

  it('buildReportPositionsShapeAndDeepBest: the exact shape, the deep best, verified wrong moves, the opening and drills', async () => {
    let student = startSession(emptyStudent('alice'), null, 1);
    student = recordAttempt(student, { gameId: gA.game.id, ply: 4, moveSan: 'd4', correct: true, lossPts: 0 });
    student = startSession(student, null, 2);
    student = recordAttempt(student, { gameId: gB.game.id, ply: 4, moveSan: 'd4', correct: true, lossPts: 0 });
    student = recordAttempt(student, { gameId: gA.game.id, ply: 4, moveSan: 'd4', correct: true, lossPts: 0 }); // same session: counts once
    student = startSession(student, null, 3);
    student = recordAttempt(student, { gameId: gC.game.id, ply: 4, moveSan: 'Bc4', correct: false, lossPts: 6 }); // wrong: no drill

    const { e, calls } = engine();
    const out = await buildReportPositions(d, games, e, student);
    expect(out).toEqual([
      {
        fen: P,
        orientation: 'white',
        wrongSan: ['Bc4', 'Na3'],
        wrongUci: 'f1c4',
        bestSan: 'd4',
        bestUci: 'd2d4',
        lossPts: 14,
        wrongTimes: 3,
        seenTimes: 4,
        opening: 'Italian Game',
        drillsDone: 2,
        drillsTotal: 3,
      },
    ]);
    expect(Object.keys(out[0]).sort()).toEqual(
      ['bestSan', 'bestUci', 'drillsDone', 'drillsTotal', 'fen', 'lossPts', 'opening', 'orientation', 'seenTimes', 'wrongSan', 'wrongTimes', 'wrongUci'].sort(),
    );
    expect(JSON.stringify(out)).not.toContain('Bb5');
    for (const c of calls) expect(c.ms).toBe(DISPLAY_CFG.movetimeMs);
    // The focus position is checked first; Q needs no search after its only move (it is the best).
    expect(calls[0].fen).toBe(P);
    expect(calls.map((c) => c.fen)).not.toContain(play(Q, 'c4'));
    // Sanity on the fixture: Bc4 really loses more than 5 at depth here.
    expect(evalToWinPct(60, null) - (100 - evalToWinPct(30, null))).toBeGreaterThan(5);
  });

  it('defaults to 0 of 3 drills without a student file, and gives at most 3 positions', async () => {
    const many: Diagnosis = { ...d, repeated: [d.repeated[2], d.repeated[2], d.repeated[2], d.repeated[2]], focus: null };
    const out = await buildReportPositions(many, games, engine().e);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ drillsDone: 0, drillsTotal: 3 });
    expect(await buildReportPositions({ ...d, repeated: [] }, games, engine().e)).toEqual([]);
  });
});
