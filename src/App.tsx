import { useState } from 'react';
import { useConnectedUser } from './hooks/useConnectedUser';
import { ConnectScreen } from './components/ConnectScreen';
import { GameList } from './components/GameList';
import type { GameSummary } from './types';

export default function App() {
  const { username, connect, disconnect } = useConnectedUser();
  const [selected, setSelected] = useState<GameSummary | null>(null);

  if (!username) {
    return <ConnectScreen onConnect={connect} />;
  }

  if (selected) {
    // ReviewScreen is wired in Task 12.
    return (
      <div className="app-shell">
        <button className="link-button" onClick={() => setSelected(null)}>
          ‹ Back
        </button>
        <p>Selected: vs {selected.opponent.username}</p>
      </div>
    );
  }

  return (
    <GameList
      username={username}
      onSelect={setSelected}
      onSwitchAccount={() => {
        setSelected(null);
        disconnect();
      }}
    />
  );
}
