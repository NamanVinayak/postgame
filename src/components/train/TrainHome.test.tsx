import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CoachPack, PackDrill } from '../../training/pack';
import type { CoachPackState } from '../../training/useCoachPack';

vi.mock('../../services/storage', () => ({ getAllProgress: vi.fn(), getTrainingDays: vi.fn() }));
import { getAllProgress, getTrainingDays } from '../../services/storage';
import { TrainHome } from './TrainHome';

const mockProgress = getAllProgress as unknown as ReturnType<typeof vi.fn>;
const mockDays = getTrainingDays as unknown as ReturnType<typeof vi.fn>;
const DAY = 86_400_000;
const NOW = new Date(2026, 10, 25, 12).getTime();

const drill = (id: string, opening: string): PackDrill => ({
  id,
  opening,
  status: 'active',
  idea: id,
  seen: 3,
  wrong: 2,
  realGames: { right: 0, needed: 3 },
  positions: [{ id: `${id}-p`, moves: ['e4'], prompt: '', best: 'e5', accept: ['e5'], whyRight: '', usual: [] }],
});

const PACK: CoachPack = {
  schema: 1,
  generated: '2026-11-21',
  openings: [
    { key: 'italian', name: 'Italian', side: 'white' },
    { key: 'kid', name: 'King’s Indian', side: 'black' },
  ],
  drills: [drill('i1', 'italian'), drill('i2', 'italian')],
};

function coach(over: Partial<CoachPackState> = {}): CoachPackState {
  return {
    url: 'https://example.com/p.json',
    pack: PACK,
    status: 'ready',
    message: null,
    refresh: vi.fn(),
    link: vi.fn(),
    unlink: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockProgress.mockReset().mockResolvedValue(new Map());
  mockDays.mockReset().mockReturnValue([]);
});

describe('TrainHome', () => {
  test('lists only openings that have drills, with learned counts', async () => {
    render(<TrainHome coach={coach()} onStart={vi.fn()} onBack={vi.fn()} now={() => NOW} />);
    expect(await screen.findByText(/Italian/)).toBeInTheDocument();
    expect(screen.getByText('0 of 2 learned')).toBeInTheDocument();
    expect(screen.queryByText(/King’s Indian/)).toBeNull();
  });

  test('starts a session with the due drills', async () => {
    const onStart = vi.fn();
    render(<TrainHome coach={coach()} onStart={onStart} onBack={vi.fn()} now={() => NOW} />);
    const start = await screen.findByRole('button', { name: /Today’s drills/ });
    expect(start).toHaveTextContent('2 due');
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ isNew: true })]), expect.any(Map));
  });

  test('nothing due: start is disabled and says so', async () => {
    mockProgress.mockResolvedValue(
      new Map([
        ['i1', { drillId: 'i1', box: 2, dueAt: NOW + DAY, lapses: 0, reviews: 1, lastPositionIndex: 0 }],
        ['i2', { drillId: 'i2', box: 2, dueAt: NOW + DAY, lapses: 0, reviews: 1, lastPositionIndex: 0 }],
        ['gone', { drillId: 'gone', box: 2, dueAt: NOW - DAY, lapses: 0, reviews: 1, lastPositionIndex: 0 }],
      ]),
    );
    render(<TrainHome coach={coach()} onStart={vi.fn()} onBack={vi.fn()} now={() => NOW} />);
    await screen.findByText('Nothing due — come back tomorrow.');
    expect(screen.getByRole('button', { name: /Today’s drills/ })).toBeDisabled();
  });

  test('weekly goal counts days trained in the last 7 days', async () => {
    mockDays.mockReturnValue(['2026-11-10', '2026-11-20', '2026-11-24', '2026-11-25']);
    render(<TrainHome coach={coach()} onStart={vi.fn()} onBack={vi.fn()} now={() => NOW} />);
    expect(await screen.findByText('Trained 3 of the last 7 days')).toBeInTheDocument();
  });

  test('shows the offline message and still works from the saved pack', async () => {
    render(
      <TrainHome
        coach={coach({ status: 'stale', message: 'Showing your last saved drills.' })}
        onStart={vi.fn()}
        onBack={vi.fn()}
        now={() => NOW}
      />,
    );
    expect(await screen.findByText('Showing your last saved drills.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Today’s drills/ })).toBeEnabled();
  });

  test('unlink asks the hook and goes back', async () => {
    const c = coach();
    const onBack = vi.fn();
    render(<TrainHome coach={c} onStart={vi.fn()} onBack={onBack} now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink coaching' }));
    await waitFor(() => expect(c.unlink).toHaveBeenCalled());
    expect(onBack).toHaveBeenCalled();
  });

  test('copy progress writes the summary to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<TrainHome coach={coach()} onStart={vi.fn()} onBack={vi.fn()} now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy progress for coach' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('2026-11-21')));
    expect(await screen.findByText('Copied — paste it into your coaching chat.')).toBeInTheDocument();
  });
});
