import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { GameSummary } from './types';

// A new app version reloads into the game list (the app has no routing). App holds that reload
// while any other screen is in view; the updater may still reload once the app is in the background.
const release = vi.fn();
vi.mock('./pwa/updates', () => ({
  holdReloadWhileVisible: vi.fn(() => release),
  holdReload: vi.fn(() => vi.fn()),
}));
vi.mock('./hooks/useConnectedUser', () => ({
  useConnectedUser: () => ({ username: 'me', connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('./training/useCoachPack', () => ({
  useCoachPack: () => ({
    url: 'https://coach.example/pack.json',
    pack: null,
    status: 'ready',
    message: null,
    refresh: vi.fn(),
    link: vi.fn(),
    unlink: vi.fn(),
  }),
}));
const game = { id: 'g1' } as GameSummary;
vi.mock('./components/GameList', () => ({
  GameList: ({ onSelect, onTrain }: { onSelect: (g: GameSummary) => void; onTrain?: () => void }) => (
    <div>
      <button onClick={() => onSelect(game)}>open game</button>
      <button onClick={onTrain}>train</button>
    </div>
  ),
}));
vi.mock('./components/ReviewScreen', () => ({
  ReviewScreen: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>back to games</button>,
}));
vi.mock('./components/train/TrainHome', () => ({
  TrainHome: ({ onStart, onBack }: { onStart: (i: [], p: Map<string, unknown>) => void; onBack: () => void }) => (
    <div>
      <button onClick={() => onStart([], new Map())}>start drills</button>
      <button onClick={onBack}>back from training</button>
    </div>
  ),
}));
vi.mock('./components/train/DrillScreen', () => ({
  DrillScreen: ({ onDone }: { onDone: () => void }) => <button onClick={onDone}>finish drills</button>,
}));

import { holdReloadWhileVisible } from './pwa/updates';
import App from './App';

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('App and app updates', () => {
  beforeEach(() => {
    vi.mocked(holdReloadWhileVisible).mockClear();
    release.mockClear();
  });

  test('theGameListDoesNotHoldTheReload', () => {
    render(<App />);
    expect(holdReloadWhileVisible).not.toHaveBeenCalled();
  });

  test('holdsTheReloadWhileAReviewIsOpen', () => {
    render(<App />);
    click('open game');
    expect(holdReloadWhileVisible).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    click('back to games');
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('holdsTheReloadThroughTrainingAndDrillsWithoutAGap', () => {
    render(<App />);
    click('train');
    click('start drills');
    click('finish drills');
    // Moving between training screens must not release the hold, even for a moment.
    expect(holdReloadWhileVisible).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    click('back from training');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
