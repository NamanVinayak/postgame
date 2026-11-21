import { describe, expect, test } from 'vitest';
import { dropPiece, judge, tapSquare, tryMove } from './moveCheck';
import { positionFen, type PackPosition } from './pack';

const castleReady = positionFen(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);

describe('tryMove', () => {
  test('king two squares is castling', () => {
    expect(tryMove(castleReady, 'e1', 'g1')).toBe('O-O');
  });
  test('captures', () => {
    expect(tryMove(positionFen(['e4', 'd5']), 'e4', 'd5')).toBe('exd5');
  });
  test('promotion auto-queens', () => {
    expect(tryMove('8/4P3/8/8/8/8/k7/4K3 w - - 0 1', 'e7', 'e8')).toBe('e8=Q');
  });
  test('illegal moves give null', () => {
    expect(tryMove(castleReady, 'e1', 'e3')).toBeNull();
    expect(tryMove(castleReady, 'a7', 'a6')).toBeNull(); // not your piece
    expect(tryMove(castleReady, 'e2', 'e4')).toBeNull(); // empty square
  });
});

const position: PackPosition = {
  id: 'p',
  moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6', 'd4', 'exd4', 'c3', 'dxc3', 'Qb3', 'Qe7'],
  prompt: '',
  best: 'Nxc3',
  accept: ['Nxc3', 'O-O'],
  whyRight: '',
  usual: [{ move: 'Qxc3', times: 4, punish: ['Qxe4+'], why: 'w' }],
};

describe('judge', () => {
  test('any accepted move is right', () => {
    expect(judge(position, 'Nxc3')).toEqual({ kind: 'right', san: 'Nxc3' });
    expect(judge(position, 'O-O')).toEqual({ kind: 'right', san: 'O-O' });
  });
  test('his usual move is recognised', () => {
    expect(judge(position, 'Qxc3')).toEqual({ kind: 'usual', san: 'Qxc3', usual: position.usual[0] });
  });
  test('anything else is other', () => {
    expect(judge(position, 'Bd5')).toEqual({ kind: 'other', san: 'Bd5' });
  });
});

describe('tapSquare (tap a piece, then a square)', () => {
  test('tapping your own piece selects it', () => {
    expect(tapSquare(null, 'f3', castleReady)).toEqual({ selected: 'f3', move: null });
  });
  test('tapping an empty or enemy square with nothing selected does nothing', () => {
    expect(tapSquare(null, 'e3', castleReady)).toEqual({ selected: null, move: null });
    expect(tapSquare(null, 'e5', castleReady)).toEqual({ selected: null, move: null });
  });
  test('with a piece selected, tapping a target asks for that move and clears the selection', () => {
    expect(tapSquare('e1', 'g1', castleReady)).toEqual({ selected: null, move: { from: 'e1', to: 'g1' } });
  });
  test('tapping another of your pieces switches the selection', () => {
    expect(tapSquare('e1', 'b1', castleReady)).toEqual({ selected: 'b1', move: null });
  });
  test('tapping the selected piece again unselects it', () => {
    expect(tapSquare('e1', 'e1', castleReady)).toEqual({ selected: null, move: null });
  });
});

describe('dropPiece (a drag that ends where it started is a tap)', () => {
  test('dropping on another square asks for that move', () => {
    expect(dropPiece(null, 'e1', 'g1', castleReady)).toEqual({ selected: null, move: { from: 'e1', to: 'g1' } });
  });
  test('a wobble that lands on the same square selects the piece', () => {
    expect(dropPiece(null, 'f3', 'f3', castleReady)).toEqual({ selected: 'f3', move: null });
    expect(dropPiece(null, 'f3', null, castleReady)).toEqual({ selected: 'f3', move: null });
  });
  test('with another piece selected, a wobble on your own piece switches to it', () => {
    expect(dropPiece('e1', 'f3', 'f3', castleReady)).toEqual({ selected: 'f3', move: null });
  });
});
