import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';
import { useConnectedUser } from './useConnectedUser';
import { getUsername, setUsername } from '../services/storage';

beforeEach(() => {
  localStorage.clear();
});

describe('useConnectedUser', () => {
  test('initializes from the stored username', () => {
    setUsername('StoredUser');
    const { result } = renderHook(() => useConnectedUser());
    expect(result.current.username).toBe('StoredUser');
  });

  test('connect persists and updates state', () => {
    const { result } = renderHook(() => useConnectedUser());
    act(() => result.current.connect('NewUser'));
    expect(result.current.username).toBe('NewUser');
    expect(getUsername()).toBe('NewUser');
  });

  test('disconnect clears username', () => {
    setUsername('X');
    const { result } = renderHook(() => useConnectedUser());
    act(() => result.current.disconnect());
    expect(result.current.username).toBeNull();
    expect(getUsername()).toBeNull();
  });
});
