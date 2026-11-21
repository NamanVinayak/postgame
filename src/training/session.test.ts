import { describe, expect, test } from 'vitest';
import { afterAnswer, type SessionState } from './session';
import type { SessionItem } from './scheduler';

function item(id: string): SessionItem {
  return {
    drill: {
      id,
      opening: 'a',
      status: 'active',
      idea: id,
      seen: 1,
      wrong: 1,
      realGames: { right: 0, needed: 3 },
      positions: [],
    },
    position: { id: `${id}-p`, moves: [], prompt: '', best: 'e4', accept: ['e4'], whyRight: '', usual: [] },
    positionIndex: 0,
    isNew: false,
    isRetry: false,
  };
}

describe('afterAnswer', () => {
  test('a right answer just moves on', () => {
    const s: SessionState = { items: [item('a'), item('b')], index: 0 };
    expect(afterAnswer(s, false)).toEqual({ items: s.items, index: 1 });
  });

  test('a wrong answer comes back once at the end', () => {
    const s = afterAnswer({ items: [item('a'), item('b')], index: 0 }, true);
    expect(s.index).toBe(1);
    expect(s.items.map((i) => [i.drill.id, i.isRetry])).toEqual([
      ['a', false],
      ['b', false],
      ['a', true],
    ]);
  });

  test('a retry answered wrong is not repeated again', () => {
    const start = afterAnswer({ items: [item('a')], index: 0 }, true);
    const s = afterAnswer(start, true);
    expect(s.items).toHaveLength(2);
    expect(s.index).toBe(2);
  });
});
