import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../services/chesscom', () => ({ playerExists: vi.fn() }));
import { playerExists } from '../services/chesscom';
import { ConnectScreen } from './ConnectScreen';

const mockExists = playerExists as unknown as ReturnType<typeof vi.fn>;

describe('ConnectScreen', () => {
  beforeEach(() => mockExists.mockReset());

  test('connects a valid username', async () => {
    mockExists.mockResolvedValue(true);
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'MagnusCarlsen' },
    });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith('MagnusCarlsen'));
  });

  test('shows an error for an unknown username and does not connect', async () => {
    mockExists.mockResolvedValue(false);
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await screen.findByRole('alert');
    expect(onConnect).not.toHaveBeenCalled();
  });
});
