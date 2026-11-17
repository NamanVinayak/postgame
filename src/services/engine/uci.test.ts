import { describe, expect, test } from 'vitest';
import { parseBestmove, parseUciInfo } from './uci';

describe('parseUciInfo', () => {
  test('parses a multipv info line with a PV', () => {
    const info = parseUciInfo(
      'info depth 20 seldepth 28 multipv 1 score cp 35 nodes 123456 nps 1234567 hashfull 12 time 100 pv e2e4 e7e5 g1f3 b8c6',
    );
    expect(info).toEqual({
      tier: 1,
      cp: 35,
      mate: null,
      pv: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
    });
  });

  test('parses the second-best tier', () => {
    const info = parseUciInfo(
      'info depth 20 multipv 2 score cp -12 time 100 pv d2d4 d7d5',
    );
    expect(info).toEqual({ tier: 2, cp: -12, mate: null, pv: ['d2d4', 'd7d5'] });
  });

  test('parses mate scores and defaults multipv to 1', () => {
    const info = parseUciInfo('info depth 12 score mate 3 time 50 pv e2e4 e7e5');
    expect(info).toEqual({ tier: 1, cp: null, mate: 3, pv: ['e2e4', 'e7e5'] });
  });

  test('handles negative mate and missing PV', () => {
    const info = parseUciInfo('info depth 12 score mate -2 time 50');
    expect(info).toEqual({ tier: 1, cp: null, mate: -2, pv: null });
  });

  test('a trailing space in the PV yields no empty move', () => {
    const info = parseUciInfo('info depth 12 score cp 10 pv e2e4 e7e5 ');
    expect(info?.pv).toEqual(['e2e4', 'e7e5']);
  });

  test('ignores lines without a score', () => {
    expect(parseUciInfo('info string Stockfish 18 by the Stockfish developers')).toBeNull();
    expect(parseUciInfo('info depth 20 currmove e2e4 currmovenumber 1')).toBeNull();
    expect(parseUciInfo('uciok')).toBeNull();
    expect(parseUciInfo('bestmove e2e4')).toBeNull();
  });
});

describe('parseBestmove', () => {
  test('parses bestmove with and without ponder', () => {
    expect(parseBestmove('bestmove e2e4 ponder e7e5')).toBe('e2e4');
    expect(parseBestmove('bestmove e7e8q')).toBe('e7e8q');
  });

  test('returns null for (none) and non-bestmove lines', () => {
    expect(parseBestmove('bestmove (none)')).toBeNull();
    expect(parseBestmove('info depth 20 score cp 10 pv e2e4')).toBeNull();
  });
});
