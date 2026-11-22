import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReportRow } from '../../src/server/views';
import { Radar, RadarLegend } from './Radar';

// The real 900-game blitz rows (as toReportView builds them from diagnosis-blitz-900.json).
const REAL: ReportRow[] = [
  { area: 'Openings', label: 'notYourProblem', you: 9.6, them: 9, range: [8.7, 10.4], games: 900 },
  { area: 'Middlegames', label: 'notYourProblem', you: 19.9, them: 19.7, range: [19, 20.9], games: 851 },
  { area: 'Endgames', label: 'notYourProblem', you: 7.4, them: 7.9, range: [6.4, 8.3], games: 354 },
  { area: "When you're behind", label: 'notYourProblem', you: 4.1, them: 4.2, range: [2.9, 5.3], games: 807 },
  { area: 'Low on the clock', label: 'notYourProblem', you: 11.3, them: 11.6, range: [8.7, 13.9], games: 341 },
  { area: "When you're ahead", label: 'noClearDifference', you: 15.6, them: 15.2, range: [12.9, 18.4], games: 874 },
];
const unknown = (area: string): ReportRow => ({ area, label: 'notEnoughData', you: null, them: null, range: null, games: 9 });

const radar = (rows: ReportRow[]) => renderToStaticMarkup(createElement(Radar, { rows, size: 'compact' }));
const legend = (rows: ReportRow[]) => renderToStaticMarkup(createElement(RadarLegend, { rows }));
/** Every <line> carrying the band's class, as its opening tag. */
const bandTags = (html: string): string[] => Array.from(html.matchAll(/<line[^>]*class="rc-range"[^>]*>/g), (m) => m[0]);
/** A tag without its coordinates, so two bands can be compared on style alone. */
const styleOf = (tag: string) => tag.replace(/\s(x1|y1|x2|y2)="[^"]*"/g, '');

describe('Radar bands and legend', () => {
  it('bandsHaveConstantStyle', () => {
    // A wide band that runs past the rim (your lowest likely rate under half theirs), next to the real rows.
    const rows: ReportRow[] = [...REAL.slice(0, 5), { ...REAL[5], range: [5, 18.4] }];
    const html = radar(rows);
    const tags = bandTags(html);
    expect(tags).toHaveLength(6); // one band per area with numbers
    const styles = new Set(tags.map(styleOf));
    expect(styles.size).toBe(1); // the same class and attributes on every spoke, whatever its position
    expect([...styles][0]).not.toMatch(/style=|opacity/); // nothing varies per band
    // The band that runs past the rim is cut there and marked with one small end tick.
    expect(html.match(/class="rc-rangeTick"/g) ?? []).toHaveLength(1);
    expect(radar(REAL).match(/class="rc-rangeTick"/g) ?? []).toHaveLength(0); // no band of the real data is cut
  });

  it('legendSwatchMatchesBand', () => {
    const chartBand = styleOf(bandTags(radar(REAL))[0]);
    const swatches = bandTags(legend(REAL));
    expect(swatches).toHaveLength(1);
    // The legend's "Where you likely are" swatch is the chart's band: same element, class and attributes.
    expect(styleOf(swatches[0])).toBe(chartBand);
    expect(legend(REAL)).toContain('Where you likely are');
  });

  it('fadedLegendOnlyWhenShapeDrawn', () => {
    // Every area has numbers: a shape, nothing faded.
    const all = legend(REAL);
    expect(all).not.toMatch(/Faded/);
    expect(all).toContain('rc-kYou');
    expect(all).toContain('The shape shows where you sit; the chips give the verdict.');

    // Two areas short of games: the shape is drawn with faded wedges, and the legend says so.
    const two = [REAL[0], REAL[1], REAL[2], unknown("When you're behind"), unknown('Low on the clock'), REAL[5]];
    expect(legend(two)).toContain('Faded = not enough games');
    expect(radar(two)).toContain('rc-youFade');

    // Three short of games: no shape, so the legend mentions neither fading nor a filled shape.
    const three = [REAL[0], REAL[1], REAL[2], unknown("When you're behind"), unknown('Low on the clock'), unknown("When you're ahead")];
    const html = legend(three);
    expect(html).not.toMatch(/Faded|fill|shape/i);
    expect(html).not.toContain('rc-kYou');
    expect(html).toContain('The dots show where you sit; the chips give the verdict.');
    expect(html).toContain('= not enough games'); // the "?" ring is still explained
    expect(radar(three)).not.toMatch(/rc-youFade|rc-youFill|class="rc-you"/);
  });
});
