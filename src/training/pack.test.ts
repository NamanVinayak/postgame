import { describe, expect, test } from 'vitest';
import { Chess } from 'chess.js';
import { PackError, parsePack, positionFen, sideToMove } from './pack';

const LINE = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6', 'd4', 'exd4', 'c3', 'dxc3', 'Qb3', 'Qe7'];

function validPack(): Record<string, unknown> {
  return {
    schema: 1,
    generated: '2026-11-21',
    openings: [
      { key: 'italian', name: 'Italian', side: 'white' },
      { key: 'sicilian', name: 'Sicilian', side: 'black' },
    ],
    drills: [
      {
        id: 'drill-a',
        opening: 'italian',
        status: 'active',
        idea: 'Idea A',
        seen: 6,
        wrong: 4,
        realGames: { right: 0, needed: 3 },
        positions: [
          {
            id: 'pos-a',
            moves: LINE,
            prompt: 'Your move.',
            best: 'Nxc3',
            accept: ['Nxc3', 'O-O'],
            whyRight: 'The knight guards your centre pawn.',
            usual: [{ move: 'Qxc3', times: 4, punish: ['Qxe4+'], why: 'Black takes with check.' }],
          },
        ],
      },
      {
        id: 'drill-b',
        opening: 'sicilian',
        status: 'active',
        idea: 'Idea B',
        seen: 3,
        wrong: 3,
        realGames: { right: 1, needed: 3 },
        positions: [
          {
            id: 'pos-b',
            moves: ['e4', 'c5', 'Nf3', 'Nc6', 'Nc3', 'e5', 'Bb5'],
            prompt: 'Your move.',
            best: 'd6',
            accept: ['d6'],
            whyRight: 'Guard the centre pawn.',
            usual: [{ move: 'Qc7', times: 2, punish: ['Nd5'], why: 'The knight hits your queen.' }],
          },
        ],
      },
    ],
  };
}

type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('parsePack', () => {
  test('parses a valid pack', () => {
    const pack = parsePack(validPack());
    expect(pack.drills.map((d) => d.id)).toEqual(['drill-a', 'drill-b']);
    expect(pack.drills[0].positions[0].usual[0]).toEqual({
      move: 'Qxc3',
      times: 4,
      punish: ['Qxe4+'],
      why: 'Black takes with check.',
    });
    expect(pack.openings).toHaveLength(2);
  });

  test('ignores unknown fields', () => {
    const raw = validPack() as Mutable;
    raw.extra = 'x';
    raw.drills[0].somethingNew = 42;
    expect(() => parsePack(raw)).not.toThrow();
  });

  test('rejects another schema version', () => {
    const raw = validPack() as Mutable;
    raw.schema = 2;
    expect(() => parsePack(raw)).toThrow(PackError);
    expect(() => parsePack(raw)).toThrow(/version/);
  });

  test('rejects something that is not a pack', () => {
    expect(() => parsePack('hello')).toThrow(PackError);
    expect(() => parsePack({ schema: 1 })).toThrow(PackError);
  });

  test('drops a drill whose line is illegal and keeps the rest', () => {
    const raw = validPack() as Mutable;
    raw.drills[0].positions[0].moves = [...LINE.slice(0, -1), 'Ke5'];
    const pack = parsePack(raw);
    expect(pack.drills.map((d) => d.id)).toEqual(['drill-b']);
  });

  test('drops a position with no legal accepted move', () => {
    const raw = validPack() as Mutable;
    raw.drills[0].positions.push({ ...raw.drills[0].positions[0], id: 'second', accept: ['Ke8'] });
    const pack = parsePack(raw);
    expect(pack.drills[0].positions.map((p) => p.id)).toEqual(['pos-a']);
  });

  test('drops a drill with no valid positions', () => {
    const raw = validPack() as Mutable;
    raw.drills[1].positions[0].accept = [];
    expect(parsePack(raw).drills.map((d) => d.id)).toEqual(['drill-a']);
  });

  test('drops a drill whose opening is not declared', () => {
    const raw = validPack() as Mutable;
    raw.drills[1].opening = 'kid';
    expect(parsePack(raw).drills.map((d) => d.id)).toEqual(['drill-a']);
  });
});

describe('positionFen / sideToMove', () => {
  test('replays SAN from the start', () => {
    const c = new Chess();
    c.move('e4');
    expect(positionFen(['e4'])).toBe(c.fen());
  });

  test('side to move follows the number of moves', () => {
    const pack = parsePack(validPack());
    expect(sideToMove(pack.drills[0].positions[0])).toBe('white');
    expect(sideToMove(pack.drills[1].positions[0])).toBe('black');
  });
});
