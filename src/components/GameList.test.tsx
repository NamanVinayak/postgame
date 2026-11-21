import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../hooks/useRecentGames', () => ({
  useRecentGames: () => ({ games: [], accuracyById: new Map(), status: 'idle', statusMessage: '', refresh: vi.fn() }),
}));
import { GameList } from './GameList';

describe('GameList coaching entry points', () => {
  test('no coach link: no Train button, but a quiet way to add one', () => {
    render(<GameList username="me" onSelect={vi.fn()} onSwitchAccount={vi.fn()} onLinkCoach={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Train' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Have a coach link?' })).toBeInTheDocument();
  });

  test('linked: Train button opens training', () => {
    const onTrain = vi.fn();
    render(<GameList username="me" onSelect={vi.fn()} onSwitchAccount={vi.fn()} onTrain={onTrain} />);
    fireEvent.click(screen.getByRole('button', { name: 'Train' }));
    expect(onTrain).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Have a coach link?' })).toBeNull();
  });

  test('pasting a link: a bad one shows why, a good one is passed on', () => {
    const onLinkCoach = vi.fn((url: string) => url.startsWith('https://'));
    render(<GameList username="me" onSelect={vi.fn()} onSwitchAccount={vi.fn()} onLinkCoach={onLinkCoach} />);
    fireEvent.click(screen.getByRole('button', { name: 'Have a coach link?' }));
    const input = screen.getByLabelText('Paste coach link');
    fireEvent.change(input, { target: { value: 'http://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(screen.getByRole('alert')).toHaveTextContent('That link needs to start with https://');
    fireEvent.change(input, { target: { value: 'https://x/p.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(onLinkCoach).toHaveBeenLastCalledWith('https://x/p.json');
  });
});
