import { useState } from 'react';
import { useConnectedUser } from './hooks/useConnectedUser';
import { ConnectScreen } from './components/ConnectScreen';
import { GameList } from './components/GameList';
import { ReviewScreen } from './components/ReviewScreen';
import type { GameSummary } from './types';

export default function App() {
  const { username, connect, disconnect } = useConnectedUser();
  const [selected, setSelected] = useState<GameSummary | null>(null);

  if (!username) {
    return <ConnectScreen onConnect={connect} />;
  }

  if (selected) {
    return <ReviewScreen game={selected} onBack={() => setSelected(null)} />;
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
