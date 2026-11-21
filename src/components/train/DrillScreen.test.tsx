import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SessionItem } from '../../training/scheduler';
import type { PackDrill } from '../../training/pack';

vi.mock('../../services/storage', () => ({ saveProgress: vi.fn(), markTrainedToday: vi.fn() }));
import { markTrainedToday, saveProgress } from '../../services/storage';
import { DrillScreen } from './DrillScreen';

const mockSave = saveProgress as unknown as ReturnType<typeof vi.fn>;
const mockMark = markTrainedToday as unknown as ReturnType<typeof vi.fn>;

const DRILL: PackDrill = {
  id: 'drill-a',
  opening: 'italian',
  status: 'active',
  idea: 'Idea A',
  seen: 6,
  wrong: 4,
  realGames: { right: 1, needed: 3 },
  positions: [
    {
      id: 'pos-a',
      moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6', 'd4', 'exd4', 'c3', 'dxc3', 'Qb3', 'Qe7'],
      prompt: 'Black defended with the queen. Your move.',
      best: 'Nxc3',
      accept: ['Nxc3', 'O-O'],
      whyRight: 'The knight recaptures.',
      usual: [{ move: 'Qxc3', times: 4, punish: ['Qxe4+', 'Kd1'], why: 'The queen takes a pawn with check.' }],
    },
  ],
};

const item = (): SessionItem => ({ drill: DRILL, position: DRILL.positions[0], positionIndex: 0, isNew: true, isRetry: false });

function tap(container: HTMLElement, square: string) {
  const el = container.querySelector(`[data-square="${square}"]`);
  if (!el) throw new Error(`no square ${square}`);
  fireEvent.click(el);
}

async function ready() {
  await screen.findByText('Black defended with the queen. Your move.');
  await screen.findByTestId('drill-ask');
}

beforeEach(() => {
  mockSave.mockReset().mockResolvedValue(undefined);
  mockMark.mockReset();
});

describe('DrillScreen', () => {
  test('a right answer explains why and asks how sure he was', async () => {
    const onDone = vi.fn();
    const { container } = render(
      <DrillScreen items={[item()]} progress={new Map()} onDone={onDone} stepDelayMs={0} />,
    );
    await ready();
    tap(container, 'b1');
    tap(container, 'c3');
    await screen.findByText('The knight recaptures.');
    fireEvent.click(screen.getByRole('button', { name: 'Knew it' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ drillId: 'drill-a', box: 1 })));
    expect(mockMark).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Train' }));
    expect(onDone).toHaveBeenCalledWith(1);
  });

  test('guessed keeps the drill in its box', async () => {
    const { container } = render(<DrillScreen items={[item()]} progress={new Map()} onDone={vi.fn()} stepDelayMs={0} />);
    await ready();
    tap(container, 'b1');
    tap(container, 'c3');
    fireEvent.click(await screen.findByRole('button', { name: 'Guessed' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ box: 1, reviews: 1 })));
  });

  test('his usual move: shows the punishment, then he must play the right move', async () => {
    const { container } = render(<DrillScreen items={[item()]} progress={new Map()} onDone={vi.fn()} stepDelayMs={0} />);
    await ready();
    tap(container, 'b3');
    tap(container, 'c3');
    await screen.findByText('You’ve played this 4 times.');
    expect(screen.getByText('The queen takes a pawn with check.')).toBeInTheDocument();
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ box: 1, lapses: 1 })));
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Show me the better move' }));
    await screen.findByText('Your turn — play it.');
    tap(container, 'a2'); // a pawn move is not the answer: nothing happens
    tap(container, 'a3');
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    tap(container, 'b1');
    tap(container, 'c3');
    expect(await screen.findByRole('button', { name: 'Next' })).toBeInTheDocument();
  });

  test('a missed drill comes back once at the end, and the retry does not change the schedule', async () => {
    const { container } = render(<DrillScreen items={[item()]} progress={new Map()} onDone={vi.fn()} stepDelayMs={0} />);
    await ready();
    tap(container, 'a2');
    tap(container, 'a3'); // some other move
    await screen.findByText('Not quite.');
    tap(container, 'b1');
    tap(container, 'c3');
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByText('2 / 2');
    await ready();
    tap(container, 'b1');
    tap(container, 'c3');
    fireEvent.click(await screen.findByRole('button', { name: 'Knew it' }));
    await screen.findByRole('button', { name: 'Back to Train' });
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  test('shows real-game progress and never offers a hint', async () => {
    render(<DrillScreen items={[item()]} progress={new Map()} onDone={vi.fn()} stepDelayMs={0} />);
    await ready();
    expect(screen.getByText('Fixed in real games: 1 of 3')).toBeInTheDocument();
    expect(screen.queryByText(/hint/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /hint/i })).toBeNull();
  });
});
