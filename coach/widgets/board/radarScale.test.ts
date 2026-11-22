import { describe, expect, it } from 'vitest';
import { MIN_RADIUS, PEER_RADIUS, relativeRadius } from './radarScale';

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
