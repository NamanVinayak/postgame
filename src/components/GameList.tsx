import { useState } from 'react';
import { useRecentGames } from '../hooks/useRecentGames';
import { GameRow } from './GameRow';
import { CoachLinkForm } from './train/CoachLinkForm';
import { COPY } from '../constants';
import { TRAIN_COPY } from '../training/copy';
import type { GameSummary } from '../types';

interface Props {
  username: string;
  onSelect: (game: GameSummary) => void;
  onSwitchAccount: () => void;
  /** Present only when a coach pack is linked. */
  onTrain?: () => void;
  /** Present when no coach pack is linked yet; returns false for an unusable link. */
  onLinkCoach?: (url: string) => boolean;
}

export function GameList({ username, onSelect, onSwitchAccount, onTrain, onLinkCoach }: Props) {
  const { games, accuracyById, status, statusMessage, refresh } = useRecentGames(username);
  const firstLoading = status === 'loading' && games.length === 0;
  const [linking, setLinking] = useState(false);

  return (
    <div className="app-shell">
      <header className="list-header">
        <div>
          <h1 className="brand-sm">{COPY.appName}</h1>
          <p className="connected">@{username}</p>
        </div>
        <div className="header-actions">
          {onTrain && (
            <button className="link-button train-link" onClick={onTrain}>
              {TRAIN_COPY.train}
            </button>
          )}
          <button className="link-button" onClick={refresh} disabled={status === 'loading'}>
            Refresh
          </button>
          <button className="link-button" onClick={onSwitchAccount}>
            Switch
          </button>
        </div>
      </header>

      <div className="status-line" aria-live="polite">
        {status === 'loading' && <span>{COPY.fetching}</span>}
        {status === 'idle' && statusMessage && <span>{statusMessage}</span>}
        {status === 'error' && <span className="error">Couldn’t reach Chess.com.</span>}
      </div>

      {firstLoading ? (
        <p className="empty">{COPY.fetching}</p>
      ) : games.length === 0 ? (
        <p className="empty">No recent standard games found for @{username}.</p>
      ) : (
        <ul className="game-list">
          {games.map((g) => (
            <li key={g.id}>
              <GameRow game={g} accuracy={accuracyById.get(g.id)} onSelect={() => onSelect(g)} />
            </li>
          ))}
        </ul>
      )}

      {!onTrain && onLinkCoach && (
        <footer className="list-footer">
          {linking ? (
            <CoachLinkForm onLink={onLinkCoach} />
          ) : (
            <button className="link-button quiet" onClick={() => setLinking(true)}>
              {TRAIN_COPY.haveLink}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}
