import { describe, expect, it } from 'vitest';
import { MIN_RADIUS, PEER_RADIUS, bandEnds, radarSummary, relativeRadius, shapeDrawn } from './radarScale';

describe('relativeRadius (the report radar, relative to players at your rating)', () => {
  it('radarEqualRatesSitExactlyOnTheHexagon', () => {
    for (const rate of [0, 0.5, 4.2, 9, 19.7, 40]) {
      expect(relativeRadius(rate, rate)).toBe(PEER_RADIUS);
    }
  });

  it('radarFewerMistakesOutsideMoreInside', () => {
    expect(relativeRadius(7.4, 7.9)).toBeGreaterThan(PEER_RADIUS); // fewer serious mistakes than them
    expect(relativeRadius(9.6, 9.0)).toBeLessThan(PEER_RADIUS); // more
    expect(relativeRadius(0, 5)).toBeGreaterThan(PEER_RADIUS);
    expect(relativeRadius(5, 0)).toBeLessThan(PEER_RADIUS);
  });

  it('radarMappingIsMonotone', () => {
    // More of your own mistakes never moves your point outwards; more of theirs never moves it in.
    const rates = Array.from({ length: 400 }, (_, i) => i / 10); // 0% … 39.9%
    for (let i = 1; i < rates.length; i++) {
      expect(relativeRadius(rates[i], 10)).toBeLessThanOrEqual(relativeRadius(rates[i - 1], 10));
      expect(relativeRadius(10, rates[i])).toBeGreaterThanOrEqual(relativeRadius(10, rates[i - 1]));
    }
    // Strictly so inside the drawn range (between half and double their rate).
    for (let you = 5.1; you < 20; you += 0.5) {
      expect(relativeRadius(you, 10)).toBeLessThan(relativeRadius(you - 0.1, 10));
    }
  });

  it('radarMappingIsSymmetric', () => {
    // Half their mistakes is as far out as double their mistakes is in, at any baseline.
    for (const them of [4, 10, 20]) {
      for (const k of [1.1, 1.5, 2]) {
        const out = relativeRadius(them / k, them) - PEER_RADIUS;
        const inn = PEER_RADIUS - relativeRadius(them * k, them);
        expect(out).toBeCloseTo(inn, 12);
      }
    }
    // The same relative gap looks the same in an area with few mistakes and one with many.
    expect(relativeRadius(5, 4)).toBeCloseTo(relativeRadius(25, 20), 12);
  });

  it('radarMappingStaysInsideTheChart', () => {
    expect(relativeRadius(5, 10)).toBe(1); // half their rate reaches the rim
    expect(relativeRadius(20, 10)).toBeCloseTo(MIN_RADIUS, 12); // double reaches the inner limit
    expect(relativeRadius(0, 10)).toBe(1);
    expect(relativeRadius(1, 10)).toBe(1);
    expect(relativeRadius(10, 0)).toBe(MIN_RADIUS);
    expect(relativeRadius(90, 10)).toBe(MIN_RADIUS);
    expect(MIN_RADIUS).toBeGreaterThan(0);
  });

  it('radarRealDataSitsOnTheHexagon', () => {
    // The real 900-game blitz report (you vs players at your rating, rounded as the card shows them):
    // every area within about half a point, so every point sits within 5% of the chart's radius of the hexagon.
    const rows: [number, number][] = [
      [9.6, 9.0],
      [19.9, 19.7],
      [7.4, 7.9],
      [4.1, 4.2],
      [11.3, 11.6],
      [15.6, 15.2],
    ];
    for (const [you, them] of rows) {
      expect(Math.abs(relativeRadius(you, them) - PEER_RADIUS)).toBeLessThan(0.05);
    }
  });
});

describe('bandEnds (where you likely are, on the same scale as your point)', () => {
  it('bandsAreCutAtTheChartEdgeWithAFlag', () => {
    // A band well inside the chart: both ends mapped, nothing cut.
    expect(bandEnds([2.9, 5.3], 4.2)).toEqual({
      inner: relativeRadius(5.3, 4.2),
      outer: relativeRadius(2.9, 4.2),
      cutInner: false,
      cutOuter: false,
    });
    // Your lowest likely rate under half theirs: the band would run past the rim, so it is cut there.
    expect(bandEnds([1, 6], 5)).toMatchObject({ outer: 1, cutOuter: true, cutInner: false });
    // Exactly half lands on the rim without being cut.
    expect(bandEnds([2.5, 6], 5)).toMatchObject({ outer: 1, cutOuter: false });
    // Your highest likely rate over double theirs: cut at the inner limit.
    expect(bandEnds([4, 12], 5)).toMatchObject({ inner: MIN_RADIUS, cutInner: true, cutOuter: false });
    // A band starting at 0% runs past the rim (no mistakes at all is infinitely better).
    expect(bandEnds([0, 6], 5)).toMatchObject({ outer: 1, cutOuter: true });
  });
});

describe('shapeDrawn', () => {
  const row = (you: number | null) => ({ area: 'A', label: 'notYourProblem' as const, you, them: you === null ? null : 5 });
  it('shapeOnlyWithThreeKnownAndAtMostTwoUnknown', () => {
    expect(shapeDrawn([row(4), row(5), row(6)])).toBe(true);
    expect(shapeDrawn([row(4), row(5), row(6), row(null), row(null)])).toBe(true);
    expect(shapeDrawn([row(4), row(5), row(6), row(null), row(null), row(null)])).toBe(false); // 3 unknown
    expect(shapeDrawn([row(4), row(5), row(null)])).toBe(false); // only 2 known
  });
});

describe('radarSummary (the chart in words, for screen readers)', () => {
  it('radarSummaryNamesOutsideAndInside', () => {
    const text = radarSummary([
      { area: 'Openings', label: 'notYourProblem', you: 9.6, them: 9.0 },
      { area: 'Endgames', label: 'gap', you: 10.9, them: 7.9 },
      { area: "When you're behind", label: 'notYourProblem', you: 4.1, them: 4.2 },
      { area: 'Middlegames', label: 'noClearDifference', you: 19.7, them: 19.7 },
      { area: 'Low on the clock', label: 'notEnoughData', you: null, them: null },
    ]);
    expect(text).toContain('Outside it, fewer serious mistakes than them: When you\'re behind.');
    expect(text).toContain('Inside it, more: Openings, Endgames.');
    expect(text).toContain('Level with them: Middlegames.');
    expect(text).toContain('Not enough games: Low on the clock.');
    expect(text).toContain('Endgames: you 10.9%, them 7.9%, weak spot');
    expect(text).toContain('Middlegames: you 19.7%, them 19.7%, too close to call');
    expect(text).not.toMatch(/\bCI\b|bootstrap|p-value|confidence/i);
    expect(text.startsWith('Your shape against players at your rating')).toBe(true); // 4 known, 1 unknown: a shape is drawn
    // Empty groups are not mentioned.
    const allOut = radarSummary([{ area: 'Openings', label: 'notYourProblem', you: 5, them: 9 }]);
    expect(allOut).not.toContain('Inside');
    expect(allOut).not.toContain('Not enough games');
  });

  it('radarSummaryNeverMentionsAShapeThatIsNotDrawn', () => {
    const unknown = (area: string) => ({ area, label: 'notEnoughData' as const, you: null, them: null });
    const text = radarSummary([
      { area: 'Openings', label: 'notYourProblem', you: 9.6, them: 9.0 },
      { area: 'Middlegames', label: 'notYourProblem', you: 19.9, them: 19.7 },
      { area: 'Endgames', label: 'gap', you: 10.9, them: 7.9 },
      unknown("When you're ahead"),
      unknown("When you're behind"),
      unknown('Low on the clock'),
    ]);
    expect(text).not.toMatch(/shape/i);
    expect(text.startsWith('Your points against players at your rating, the dashed hexagon.')).toBe(true);
  });
});
