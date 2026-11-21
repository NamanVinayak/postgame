import { describe, expect, test } from 'vitest';
import { progressSummary } from './summary';
import type { CoachPack, PackDrill } from './pack';
import type { DrillProgress } from './scheduler';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 12);

const drill = (id: string, idea: string): PackDrill => ({
  id,
  opening: 'italian',
  status: 'active',
  idea,
  seen: 3,
  wrong: 2,
  realGames: { right: 0, needed: 3 },
  positions: [{ id: `${id}-p`, moves: ['e4'], prompt: '', best: 'e5', accept: ['e5'], whyRight: '', usual: [] }],
});

const pack: CoachPack = {
  schema: 1,
  generated: '2026-11-21',
  openings: [{ key: 'italian', name: 'Italian', side: 'white' }],
  drills: [drill('a', 'Steady idea'), drill('b', 'Hard idea'), drill('c', 'Untouched idea')],
};

const p = (drillId: string, box: number, lapses: number, dueAt: number): DrillProgress => ({
  drillId,
  box,
  dueAt,
  lapses,
  reviews: 4,
  lastPositionIndex: 0,
});

describe('progressSummary', () => {
  test('lists tricky ones first, then every drill in plain words', () => {
    const progress = new Map([
      ['a', p('a', 3, 0, NOW + 2 * DAY)],
      ['b', p('b', 1, 3, NOW - DAY)],
      ['gone', p('gone', 2, 0, NOW)],
    ]);
    const text = progressSummary(pack, progress, NOW);
    const lines = text.split('\n');
    const tricky = lines.indexOf('Tricky ones:');
    expect(tricky).toBeGreaterThan(-1);
    expect(lines[tricky + 1]).toContain('Hard idea');
    expect(lines[tricky + 1]).toContain('missed 3 times');
    expect(text).toContain('Steady idea — box 3, missed 0 times, due in 2 days');
    expect(text).toContain('Untouched idea — not started');
    expect(text).not.toContain('gone');
    expect(text).toContain('2026-11-21');
  });

  test('no tricky section when nothing is a leech', () => {
    expect(progressSummary(pack, new Map(), NOW)).not.toContain('Tricky ones:');
  });
});
