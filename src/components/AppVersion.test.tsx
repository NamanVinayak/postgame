import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AppVersion } from './AppVersion';
import { ConnectScreen } from './ConnectScreen';

vi.mock('../hooks/useRecentGames', () => ({
  useRecentGames: () => ({ games: [], accuracyById: new Map(), status: 'idle', statusMessage: '', refresh: vi.fn() }),
}));
import { GameList } from './GameList';

describe('AppVersion', () => {
  test('shows the build-time commit and build date', () => {
    render(<AppVersion />);
    const line = screen.getByText(/^Version /);
    expect(line).toHaveTextContent(`Version ${__APP_COMMIT__} · ${__APP_BUILD_DATE__}`);
    expect(__APP_COMMIT__).toMatch(/^([0-9a-f]{7,}|dev)$/);
    expect(__APP_BUILD_DATE__).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('is visible on the connect screen and at the bottom of the game list', () => {
    const { unmount } = render(<ConnectScreen onConnect={vi.fn()} />);
    expect(screen.getByText(/^Version /)).toBeInTheDocument();
    unmount();
    render(<GameList username="me" onSelect={vi.fn()} onSwitchAccount={vi.fn()} />);
    expect(screen.getByText(/^Version /)).toBeInTheDocument();
  });
});
