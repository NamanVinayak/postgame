import { describe, expect, it } from 'vitest';
import type { CachedGame } from '../analysis/cache';
import { STATS_CFG } from '../config';
import { AREA_KEYS, type AreaKey } from './areas';
import { areaFinding, diagnose, type AreaFinding, type Baseline, type Diagnosis } from './diagnose';
import { fixtureGame, middlegameSet, randomSans, shuffleSans, spreadRows, testRng } from './testGames';

const row = (d: Diagnosis, area: AreaKey): AreaFinding => d.areas.find((a) => a.area === area)!;

describe('diagnose', () => {
  it('equalRatesGiveNotYourProblem', () => {
    // 300 games, 30 middlegame moves per side each, both sides err on 6% (540 of 9000)
    const d = diagnose(middlegameSet(300, 540, 540, 11), ['alice']);
    const mg = row(d, 'middlegame');
    expect(mg.label).toBe('notYourProblem');
    expect(mg).toMatchObject({ games: 300, myGames: 300, oppGames: 300, myMoves: 9000, oppMoves: 9000 });
    expect(mg.myRate).toBeCloseTo(6, 10);
    expect(mg.oppRate).toBeCloseTo(6, 10);
    expect(mg.ci95[1]).toBeLessThan(STATS_CFG.meaningfulGapPts);
    expect(mg.notes).toContain('same games, resampled by game');
    expect(d.focus).toBeNull();
    expect(d.notes).toContain(
      'Among the areas with enough games, none stands out against players at your rating in the same games.',
    );
  });

  it('wideRangeGivesNoClearDifference', () => {
    // 40 games: 90 vs 72 errors over 1200 moves per side = a 1.5-point gap, too few games to call
    const d = diagnose(middlegameSet(40, 90, 72, 12), ['alice']);
    const mg = row(d, 'middlegame');
    expect(mg.gapPts).toBeCloseTo(1.5, 10);
    expect(mg.label).toBe('noClearDifference');
    expect(mg.ci95[1]).toBeGreaterThanOrEqual(STATS_CFG.meaningfulGapPts);
    expect(mg.ciAdj[0]).toBeLessThanOrEqual(0);
    expect(d.notes.join(' ')).toMatch(/tentative, not proven/);
  });

  it('clearGapIsLabelledAndBecomesTheFocus', () => {
    // 300 games: I err on 10%, opponents on 5%
    const d = diagnose(middlegameSet(300, 900, 450, 13), ['alice']);
    const mg = row(d, 'middlegame');
    expect(mg.label).toBe('gap');
    expect(mg.gapPts).toBeCloseTo(5, 10);
    expect(mg.ciAdj[0]).toBeGreaterThan(0);
    expect(mg.ciAdj[0]).toBeLessThan(mg.ci95[0]);
    expect(d.focus).toEqual({ kind: 'area', area: 'middlegame' });
    // no endgame, converting or defending moves in these games
    for (const a of ['endgame', 'converting', 'defending'] as AreaKey[]) expect(row(d, a).label).toBe('notEnoughData');
  });

  it('smallButClearGapIsCalledGapByTheBriefOrder', () => {
    // Pins the label order (gap is checked before notYourProblem): 2% vs 1% over 300 games is a
    // real 1-point gap whose 95% range also sits below meaningfulGapPts. It is called a gap.
    const d = diagnose(middlegameSet(300, 180, 90, 21), ['alice']);
    const mg = row(d, 'middlegame');
    expect(mg.gapPts).toBeCloseTo(1, 10);
    expect(mg.ci95[1]).toBeLessThan(STATS_CFG.meaningfulGapPts);
    expect(mg.ciAdj[0]).toBeGreaterThan(0);
    expect(mg.label).toBe('gap');
    expect(d.focus).toEqual({ kind: 'area', area: 'middlegame' });
  });

  it('thinnerSideDecidesNotEnoughData', () => {
    // Plenty of opponent moves cannot make up for too few of the player's (and the reverse).
    const fewMyGames = Array.from({ length: 60 }, (_, i) => ({ myErr: i < 20 ? 1 : 0, myN: i < 20 ? 30 : 0, oppErr: 1, oppN: 30 }));
    const a = areaFinding('converting', fewMyGames);
    expect(a.label).toBe('notEnoughData');
    expect(a.notes).toContain('your moves here come from only 20 games; 30 needed');
    const fewOppMoves = Array.from({ length: 60 }, () => ({ myErr: 1, myN: 30, oppErr: 0, oppN: 2 }));
    const b = areaFinding('defending', fewOppMoves);
    expect(b.label).toBe('notEnoughData');
    expect(b.notes).toContain("only 120 of your opponents' moves fall here; 150 needed");
  });

  it('sevenVsZeroAtFloorsIsNotGap', () => {
    // 30 games, 150 moves a side: 7 serious mistakes against none is too few mistakes to judge.
    const rows = Array.from({ length: 30 }, (_, g) => ({ myErr: g < 7 ? 1 : 0, myN: 5, oppErr: 0, oppN: 5 }));
    const a = areaFinding('middlegame', rows);
    expect(a.label).toBe('notEnoughData');
    expect(a.notes).toContain('only 7 serious mistakes fall here; 20 needed to judge');
  });

  it('zeroVsZeroIsNotEnoughData', () => {
    const rows = Array.from({ length: 30 }, () => ({ myErr: 0, myN: 5, oppErr: 0, oppN: 5 }));
    const a = areaFinding('endgame', rows);
    expect(a.label).toBe('notEnoughData');
    expect(a.notes).toContain('no serious mistakes fall here; 20 needed to judge');
  });

  it('exactTestBlocksBorderlineGap', () => {
    // 18 vs 6 mistakes over 1,000 moves a side: the resampled range clears zero, but 18 of 24
    // mistakes landing on one side of an even split is not rare enough (p ≈ 0.011 > 0.0042).
    const a = areaFinding('middlegame', spreadRows(40, 25, 18, 6, 5));
    expect(a.ciAdj[0]).toBeGreaterThan(0);
    expect(a.exactP).toBeCloseTo(190051 / 2 ** 24, 12);
    expect(a.exactP!).toBeGreaterThan(STATS_CFG.gapAlpha / 2);
    expect(a.label).not.toBe('gap');
  });

  it('clearGapStillGap', () => {
    const a = areaFinding('middlegame', spreadRows(50, 30, 60, 25, 5)); // 60 vs 25 over 1,500 moves a side
    expect(a.ciAdj[0]).toBeGreaterThan(0);
    expect(a.exactP!).toBeLessThan(STATS_CFG.gapAlpha / 2);
    expect(a.label).toBe('gap');
  });

  it('diagnoseFiltersToUsernames', () => {
    const alice = middlegameSet(40, 60, 60, 19);
    const carol = middlegameSet(10, 60, 0, 20).map((c, i) => ({
      ...c,
      game: { ...c.game, id: `carol-${i}`, username: 'carol' },
    }));
    const d = diagnose([...alice, ...carol], ['ALICE']);
    expect(d.games).toBe(40);
    expect(d.usernames).toEqual(['ALICE']);
    expect(d.notes.join(' ')).toMatch(/10 games from other accounts were left out/);
    expect(diagnose([...alice, ...carol], ['alice', 'Carol']).games).toBe(50);
  });

  it('fewGamesGivesNotEnoughData', () => {
    const d = diagnose(middlegameSet(12, 40, 10, 14), ['alice']);
    expect(d.games).toBe(12);
    expect(d.areas.map((a) => a.area)).toEqual(AREA_KEYS);
    for (const a of d.areas) expect(a.label).toBe('notEnoughData');
    expect(d.focus).toBeNull();
    expect(d.notes.join(' ')).toMatch(/12 games/);

    // the same few games, but alice keeps going wrong in one position: that becomes the focus
    const sans = shuffleSans(40);
    const wrong = sans.map((_, i) => (i >= 2 ? 42 : 50)); // 2. Ng1 loses 8 points
    const games = Array.from({ length: 12 }, (_, g) =>
      fixtureGame({ id: `r${g}`, sans, wins: g < 3 ? wrong : undefined }),
    );
    const r = diagnose(games, ['alice']);
    for (const a of r.areas) expect(a.label).toBe('notEnoughData');
    expect(r.repeated).toHaveLength(1);
    expect(r.focus).toEqual({ kind: 'repeated', keys: [r.repeated[0].key] });
  });

  it('handles no games at all without inventing anything', () => {
    const d = diagnose([], ['alice']);
    expect(d.games).toBe(0);
    expect(d.areas.map((a) => a.label)).toEqual(AREA_KEYS.map(() => 'notEnoughData'));
    expect(d.focus).toBeNull();
    expect(d.notes.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d); // no NaN or undefined anywhere
  });

  it('says when games lack clock times, and leaves time pressure unjudged', () => {
    const games = middlegameSet(60, 100, 100, 15).map((c, i) =>
      i < 20 ? { ...c, game: { ...c.game, clocks: c.game.clocks.map(() => null) } } : c,
    );
    const d = diagnose(games, ['alice']);
    expect(d.notes.join(' ')).toMatch(/clock times; 20 of 60 games had none/);
    expect(row(d, 'timePressure').label).toBe('notEnoughData');
  });

  it('uses a plugged-in baseline instead of the same-game opponents', () => {
    const flat: Baseline = {
      name: 'a flat 2% reference',
      perGame: (_c, area) => (area === 'middlegame' ? { oppErr: 0.6, oppN: 30 } : { oppErr: 0, oppN: 0 }),
    };
    const d = diagnose(middlegameSet(300, 540, 540, 16), ['alice'], flat);
    const mg = row(d, 'middlegame');
    expect(mg.oppRate).toBeCloseTo(2, 10);
    expect(mg.gapPts).toBeCloseTo(4, 10);
    expect(mg.label).toBe('gap');
    expect(mg.exactP).toBeNull(); // fractional counts: the exact count check is skipped, and said so
    expect(mg.notes.join(' ')).toMatch(/not whole counts/);
    expect(d.notes.join(' ')).toMatch(/a flat 2% reference/);
  });

  it('is deterministic, JSON-safe and dated by the newest game', () => {
    const games = middlegameSet(50, 80, 60, 17);
    const a = diagnose(games, ['alice']);
    expect(diagnose(games, ['alice'])).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(a.asOf).toBe(Math.max(...games.map((c) => c.game.endTime)));
    expect(a.timeClass).toBe('blitz');
    expect(a.usernames).toEqual(['alice']);
  });

  it('leaves out games that cannot be replayed, and says so', () => {
    const games = [...middlegameSet(40, 60, 60, 18), fixtureGame({ id: 'broken', sans: ['e4', 'e4'] })];
    const d = diagnose(games, ['alice']);
    expect(d.games).toBe(40);
    expect(d.notes.join(' ')).toMatch(/1 game could not be replayed/);
  });

  it('diagnoses 300 games with realistic positions in well under 2 s', () => {
    const templates = Array.from({ length: 10 }, (_, t) => randomSans(100 + t, 84));
    const rng = testRng(99);
    const games: CachedGame[] = Array.from({ length: 300 }, (_, g) => {
      const sans = templates[g % 10];
      let w = 50;
      const wins = sans.map((_, i) => {
        const loss = rng() < 0.06 ? 10 + rng() * 15 : rng() * 3;
        w = Math.min(100, Math.max(0, i % 2 === 0 ? w - loss : w + loss));
        return w;
      });
      const clocks = sans.map((_, i) => Math.max(1, 180 - i * 2.2));
      return fixtureGame({ id: `perf-${g}`, sans, wins, clocks, myColor: g % 2 ? 'black' : 'white', endTime: 1_700_000_000 + g });
    });
    const t0 = performance.now();
    const d = diagnose(games, ['alice']);
    const ms = performance.now() - t0;
    expect(d.games).toBe(300);
    expect(ms).toBeLessThan(2000);
  });
});
