import { describe, expect, it, vi } from 'vitest';

// "Clearly winning" is worded from LEAK_CFG, never hard-coded: with three own moves in a row, the text says three.
vi.mock('../config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config')>();
  return { ...real, LEAK_CFG: { ...real.LEAK_CFG, winningConsecutive: 3 } };
});

describe('leakDiagnosisText wording follows the config', () => {
  it('clearlyWinningWordedFromConfig', async () => {
    const { leakDiagnosisText } = await import('./leakText');
    const { leakReport } = await import('../diagnosis/leaks');
    const text = leakDiagnosisText(leakReport([], ['alice']), { context: null, gamesByAccount: [], repeated: 0 });
    // No games: the conversion line isn't there, so check through a report with one game.
    expect(text).not.toContain('two of your moves');
    const { fixtureGame, shuffleSans } = await import('../diagnosis/testGames');
    const g = fixtureGame({ id: 'g', sans: shuffleSans(20), wins: shuffleSans(20).map((_, i) => (i === 0 ? 50 : 85)) });
    const one = leakDiagnosisText(leakReport([g], ['alice']), { context: null, gamesByAccount: [], repeated: 0 });
    expect(one).toContain('winning chances of 75% or more on three of your moves in a row');
  });
});
