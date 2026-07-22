import { useState, type FormEvent } from 'react';
import { playerExists } from '../services/chesscom';
import { COPY } from '../constants';

interface Props {
  onConnect: (name: string) => void;
  /** Shown when switching accounts (lets the user cancel back). */
  onCancel?: () => void;
}

export function ConnectScreen({ onConnect, onCancel }: Props) {
  const [name, setName] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter your Chess.com username.');
      return;
    }
    setChecking(true);
    setError(null);
    try {
      if (await playerExists(trimmed)) {
        onConnect(trimmed);
      } else {
        setError(`No Chess.com player named “${trimmed}”.`);
      }
    } catch {
      setError('Could not reach Chess.com. Check your connection.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="app-shell connect">
      <div className="connect-card">
        <h1 className="brand">{COPY.appName}</h1>
        <p className="tagline">Free game review for the games you play on Chess.com.</p>
        <form onSubmit={submit}>
          <label htmlFor="username">Chess.com username</label>
          <input
            id="username"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="e.g. MagnusCarlsen"
            disabled={checking}
          />
          <button type="submit" disabled={checking}>
            {checking ? 'Checking…' : 'Connect'}
          </button>
          {onCancel && (
            <button type="button" className="link-button" onClick={onCancel} disabled={checking}>
              Cancel
            </button>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
        <p className="disclaimer">
          Not affiliated with Chess.com. Reads only your public games — no password needed.
        </p>
      </div>
    </div>
  );
}
