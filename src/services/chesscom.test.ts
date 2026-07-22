import { describe, expect, test } from 'vitest';
import { normalizeGame } from './chesscom';
import fixtures from './__fixtures__/games.json';

const [whiteWin, blackLoss, draw, chess960] = fixtures;

describe('normalizeGame', () => {
  test('maps a white win from the user perspective', () => {
    const g = normalizeGame(whiteWin, 'MyUser');
    expect(g).not.toBeNull();
    expect(g!.myColor).toBe('white');
    expect(g!.outcome).toBe('win');
    expect(g!.opponent).toEqual({ username: 'rivalA', rating: 990 });
    expect(g!.myRating).toBe(1005);
    expect(g!.timeClass).toBe('blitz');
    expect(g!.id).toBe(g!.url);
  });

  test('username match is case-insensitive (user was black and lost)', () => {
    const g = normalizeGame(blackLoss, 'MyUser'); // fixture stores "myuser"
    expect(g!.myColor).toBe('black');
    expect(g!.outcome).toBe('loss');
    expect(g!.opponent.username).toBe('rivalB');
  });

  test('agreed result is a draw', () => {
    const g = normalizeGame(draw, 'myuser'); // fixture stores "MyUser"
    expect(g!.outcome).toBe('draw');
    expect(g!.rated).toBe(false);
  });

  test('non-standard rules (chess960) are filtered out', () => {
    expect(normalizeGame(chess960, 'MyUser')).toBeNull();
  });
});
