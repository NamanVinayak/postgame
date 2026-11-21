import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CoachPack } from './pack';

vi.mock('../services/storage', () => ({
  getCachedPack: vi.fn(),
  saveCachedPack: vi.fn(),
  clearCachedPack: vi.fn(),
}));

import { clearCachedPack, getCachedPack, saveCachedPack } from '../services/storage';
import { useCoachPack } from './useCoachPack';
import { setCoachPackUrl } from './coachLink';

const mockGetCached = getCachedPack as unknown as ReturnType<typeof vi.fn>;
const mockSave = saveCachedPack as unknown as ReturnType<typeof vi.fn>;
const mockClear = clearCachedPack as unknown as ReturnType<typeof vi.fn>;

const PACK: CoachPack = {
  schema: 1,
  generated: '2026-11-21',
  openings: [{ key: 'italian', name: 'Italian', side: 'white' }],
  drills: [
    {
      id: 'd1',
      opening: 'italian',
      status: 'active',
      idea: 'idea',
      seen: 3,
      wrong: 2,
      realGames: { right: 0, needed: 3 },
      positions: [
        { id: 'p1', moves: ['e4', 'e5'], prompt: 'p', best: 'Nf3', accept: ['Nf3'], whyRight: 'w', usual: [] },
      ],
    },
  ],
};

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  mockGetCached.mockReset().mockResolvedValue(null);
  mockSave.mockReset().mockResolvedValue(undefined);
  mockClear.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

describe('useCoachPack', () => {
  test('nothing linked: status none, no fetch', () => {
    const { result } = renderHook(() => useCoachPack());
    expect(result.current.status).toBe('none');
    expect(result.current.pack).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('linked: fetches, validates, caches', async () => {
    setCoachPackUrl('https://example.com/p.json');
    fetchMock.mockReturnValue(ok(PACK));
    const { result } = renderHook(() => useCoachPack());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.pack?.drills).toHaveLength(1);
    expect(mockSave).toHaveBeenCalled();
  });

  test('a ?coach= link is picked up on first render', async () => {
    window.history.replaceState({}, '', '/?coach=https%3A%2F%2Fexample.com%2Fp.json');
    fetchMock.mockReturnValue(ok(PACK));
    const { result } = renderHook(() => useCoachPack());
    expect(result.current.url).toBe('https://example.com/p.json');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  test('offline with a saved pack: keeps working from it', async () => {
    setCoachPackUrl('https://example.com/p.json');
    mockGetCached.mockResolvedValue(PACK);
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useCoachPack());
    await waitFor(() => expect(result.current.message).toBe('Showing your last saved drills.'));
    expect(result.current.status).toBe('stale');
    expect(result.current.pack?.drills).toHaveLength(1);
  });

  test('bad file with nothing saved: error', async () => {
    setCoachPackUrl('https://example.com/p.json');
    fetchMock.mockReturnValue(ok({ schema: 9 }));
    const { result } = renderHook(() => useCoachPack());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.message).toBe('Couldn’t load your coach file.');
    expect(result.current.pack).toBeNull();
  });

  test('re-linking the same link loads again instead of hanging', async () => {
    setCoachPackUrl('https://example.com/p.json');
    fetchMock.mockReturnValue(ok(PACK));
    const { result } = renderHook(() => useCoachPack());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => {
      result.current.link('https://example.com/p.json');
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('link rejects non-https; unlink clears everything', async () => {
    fetchMock.mockReturnValue(ok(PACK));
    const { result } = renderHook(() => useCoachPack());
    let accepted = true;
    act(() => {
      accepted = result.current.link('http://example.com/p.json');
    });
    expect(accepted).toBe(false);
    act(() => {
      accepted = result.current.link('https://example.com/p.json');
    });
    expect(accepted).toBe(true);
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.unlink());
    expect(result.current.url).toBeNull();
    expect(result.current.pack).toBeNull();
    expect(result.current.status).toBe('none');
    expect(mockClear).toHaveBeenCalled();
  });
});
