import { describe, expect, test } from 'vitest';
import {
  applyAnswer,
  buildSession,
  isLearned,
  isLeech,
  type DrillProgress,
} from './scheduler';
import type { CoachPack, PackDrill } from './pack';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 21, 12);

function prog(drillId: string, box: number, dueAt: number, extra: Partial<DrillProgress> = {}): DrillProgress {
  return { drillId, box, dueAt, lapses: 0, reviews: 1, lastPositionIndex: 0, ...extra };
}

describe('applyAnswer', () => {
  test('a new drill answered right goes to box 1, due tomorrow', () => {
    const p = applyAnswer(undefined, 'd1', 'right', NOW);
    expect(p).toMatchObject({ drillId: 'd1', box: 1, dueAt: NOW + 1 * DAY, lapses: 0, reviews: 1 });
  });

  test('right moves up one box with that box interval', () => {
    expect(applyAnswer(prog('d', 2, NOW), 'd', 'right', NOW)).toMatchObject({ box: 3, dueAt: NOW + 7 * DAY });
    expect(applyAnswer(prog('d', 4, NOW), 'd', 'right', NOW)).toMatchObject({ box: 5, dueAt: NOW + 35 * DAY });
  });

  test('past box 5 a drill is learned and comes back after 60 days', () => {
    const p = applyAnswer(prog('d', 5, NOW), 'd', 'right', NOW);
    expect(p).toMatchObject({ box: 6, dueAt: NOW + 60 * DAY });
    expect(isLearned(p)).toBe(true);
    expect(applyAnswer(p, 'd', 'right', NOW)).toMatchObject({ box: 6, dueAt: NOW + 60 * DAY });
  });

  test('wrong goes back to box 1, due tomorrow, and counts a lapse', () => {
    const p = applyAnswer(prog('d', 4, NOW, { lapses: 1 }), 'd', 'wrong', NOW);
    expect(p).toMatchObject({ box: 1, dueAt: NOW + 1 * DAY, lapses: 2, reviews: 2 });
  });

  test('guessed stays in its box', () => {
    expect(applyAnswer(prog('d', 3, NOW), 'd', 'guessed', NOW)).toMatchObject({ box: 3, dueAt: NOW + 7 * DAY });
    expect(applyAnswer(undefined, 'd', 'guessed', NOW)).toMatchObject({ box: 1, dueAt: NOW + 1 * DAY });
  });

  test('records which position was shown', () => {
    expect(applyAnswer(prog('d', 3, NOW), 'd', 'right', NOW, 2).lastPositionIndex).toBe(2);
  });

  test('three lapses make a leech', () => {
    expect(isLeech(prog('d', 1, NOW, { lapses: 2 }))).toBe(false);
    expect(isLeech(prog('d', 1, NOW, { lapses: 3 }))).toBe(true);
  });
});

function drill(id: string, opening: string, positions = 1, status: 'active' | 'retired' = 'active'): PackDrill {
  return {
    id,
    opening,
    status,
    idea: id,
    seen: 3,
    wrong: 2,
    realGames: { right: 0, needed: 3 },
    positions: Array.from({ length: positions }, (_, i) => ({
      id: `${id}-p${i}`,
      moves: ['e4'],
      prompt: 'p',
      best: 'e5',
      accept: ['e5'],
      whyRight: 'w',
      usual: [],
    })),
  };
}

function pack(drills: PackDrill[]): CoachPack {
  return {
    schema: 1,
    generated: '2026-11-21',
    openings: [
      { key: 'a', name: 'A', side: 'white' },
      { key: 'b', name: 'B', side: 'black' },
    ],
    drills,
  };
}

describe('buildSession', () => {
  test('serves due drills and new drills, skips retired and not-yet-due', () => {
    const p = pack([drill('due', 'a'), drill('later', 'a'), drill('new', 'b'), drill('old', 'a', 1, 'retired')]);
    const progress = new Map([
      ['due', prog('due', 2, NOW - DAY)],
      ['later', prog('later', 2, NOW + DAY)],
      ['old', prog('old', 2, NOW - DAY)],
    ]);
    const s = buildSession(p, progress, NOW);
    expect(s.map((i) => i.drill.id).sort()).toEqual(['due', 'new']);
    expect(s.find((i) => i.drill.id === 'new')?.isNew).toBe(true);
    expect(s.every((i) => !i.isRetry)).toBe(true);
  });

  test('at most 10 items and at most 5 new', () => {
    const drills = Array.from({ length: 20 }, (_, i) => drill(`n${i}`, i % 2 ? 'a' : 'b'));
    const s = buildSession(pack(drills), new Map(), NOW);
    expect(s).toHaveLength(5);
    const due = Array.from({ length: 8 }, (_, i) => drill(`d${i}`, i % 2 ? 'a' : 'b'));
    const progress = new Map(due.map((d, i) => [d.id, prog(d.id, 2, NOW - i * DAY)]));
    const s2 = buildSession(pack([...due, ...drills]), progress, NOW);
    expect(s2).toHaveLength(10);
    expect(s2.filter((i) => i.isNew)).toHaveLength(2);
  });

  test('a long absence: 25 overdue → 10 oldest, no new, nothing reset', () => {
    const due = Array.from({ length: 25 }, (_, i) => drill(`d${i}`, i % 2 ? 'a' : 'b'));
    const progress = new Map(due.map((d, i) => [d.id, prog(d.id, 3, NOW - (40 + i) * DAY)]));
    const before = JSON.stringify([...progress.values()]);
    const s = buildSession(pack([...due, drill('new', 'a')]), progress, NOW);
    expect(s).toHaveLength(10);
    expect(s.some((i) => i.isNew)).toBe(false);
    const oldest10 = due.slice(15).map((d) => d.id).sort();
    expect(s.map((i) => i.drill.id).sort()).toEqual(oldest10);
    expect(s[0].drill.id).toBe('d24');
    expect(JSON.stringify([...progress.values()])).toBe(before);
  });

  test('more than 15 overdue → no new drills even if fewer than 10 shown', () => {
    const due = Array.from({ length: 16 }, (_, i) => drill(`d${i}`, 'a'));
    const progress = new Map(due.map((d) => [d.id, prog(d.id, 2, NOW - DAY)]));
    const s = buildSession(pack([...due, drill('new', 'b')]), progress, NOW);
    expect(s.some((i) => i.isNew)).toBe(false);
  });

  test('avoids the same opening twice in a row when it can', () => {
    const ds = [drill('a1', 'a'), drill('a2', 'a'), drill('a3', 'a'), drill('b1', 'b'), drill('b2', 'b')];
    const progress = new Map(ds.map((d, i) => [d.id, prog(d.id, 2, NOW - (10 - i) * DAY)]));
    const s = buildSession(pack(ds), progress, NOW).map((i) => i.drill.opening);
    expect(s).toEqual(['a', 'b', 'a', 'b', 'a']);
  });

  test('rotates positions from box 3 on, first position below box 3', () => {
    const ds = [drill('low', 'a', 3), drill('high', 'b', 3)];
    const progress = new Map([
      ['low', prog('low', 2, NOW - DAY, { lastPositionIndex: 1 })],
      ['high', prog('high', 3, NOW - DAY, { lastPositionIndex: 2 })],
    ]);
    const s = buildSession(pack(ds), progress, NOW);
    expect(s.find((i) => i.drill.id === 'low')?.positionIndex).toBe(0);
    const high = s.find((i) => i.drill.id === 'high');
    expect(high?.positionIndex).toBe(0);
    expect(high?.position.id).toBe('high-p0');
  });

  test('new drills are picked across openings, not in file order', () => {
    const ds = [
      drill('a1', 'a'),
      drill('a2', 'a'),
      drill('a3', 'a'),
      drill('a4', 'a'),
      drill('a5', 'a'),
      drill('b1', 'b'),
      drill('b2', 'b'),
    ];
    const s = buildSession(pack(ds), new Map(), NOW);
    expect(s.map((i) => i.drill.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  test('ignores progress for drills no longer in the pack', () => {
    const progress = new Map([['gone', prog('gone', 2, NOW - DAY)]]);
    expect(buildSession(pack([drill('x', 'a')]), progress, NOW).map((i) => i.drill.id)).toEqual(['x']);
  });
});

describe('new drills per day', () => {
  test('the first answer records when a drill was introduced, later answers keep it', () => {
    const first = applyAnswer(undefined, 'd', 'right', NOW);
    expect(first.introducedAt).toBe(NOW);
    expect(applyAnswer(first, 'd', 'right', NOW + 5 * DAY).introducedAt).toBe(NOW);
  });

  test('at most 5 new drills per day, across sessions', () => {
    const ds = Array.from({ length: 12 }, (_, i) => drill(`n${i}`, i % 2 ? 'a' : 'b'));
    const progress = new Map(
      ['n0', 'n1', 'n2'].map((id) => [id, { ...prog(id, 1, NOW + DAY), introducedAt: NOW - 3_600_000 }]),
    );
    const s = buildSession(pack(ds), progress, NOW);
    expect(s.filter((i) => i.isNew)).toHaveLength(2);
    const allFive = new Map(
      ['n0', 'n1', 'n2', 'n3', 'n4'].map((id) => [id, { ...prog(id, 1, NOW + DAY), introducedAt: NOW - 3_600_000 }]),
    );
    expect(buildSession(pack(ds), allFive, NOW)).toHaveLength(0);
  });

  test('drills introduced yesterday do not count against today', () => {
    const ds = Array.from({ length: 12 }, (_, i) => drill(`n${i}`, i % 2 ? 'a' : 'b'));
    const progress = new Map(
      ['n0', 'n1', 'n2', 'n3', 'n4'].map((id) => [id, { ...prog(id, 1, NOW + DAY), introducedAt: NOW - 2 * DAY }]),
    );
    expect(buildSession(pack(ds), progress, NOW).filter((i) => i.isNew)).toHaveLength(5);
  });
});
