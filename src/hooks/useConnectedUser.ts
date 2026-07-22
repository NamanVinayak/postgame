import { useCallback, useState } from 'react';
import { clearUsername, getUsername, setUsername } from '../services/storage';

export interface ConnectedUser {
  username: string | null;
  connect: (name: string) => void;
  disconnect: () => void;
}

/** The currently connected Chess.com username, backed by localStorage. */
export function useConnectedUser(): ConnectedUser {
  const [username, setUsernameState] = useState<string | null>(() => getUsername());

  const connect = useCallback((name: string) => {
    const trimmed = name.trim();
    setUsername(trimmed);
    setUsernameState(trimmed);
  }, []);

  const disconnect = useCallback(() => {
    clearUsername();
    setUsernameState(null);
  }, []);

  return { username, connect, disconnect };
}
