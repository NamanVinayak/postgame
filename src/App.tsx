import { useState } from 'react';
import { useConnectedUser } from './hooks/useConnectedUser';
import { ConnectScreen } from './components/ConnectScreen';
import { GameList } from './components/GameList';
import { ReviewScreen } from './components/ReviewScreen';
import { TrainHome } from './components/train/TrainHome';
import { DrillScreen } from './components/train/DrillScreen';
import { useCoachPack } from './training/useCoachPack';
import type { DrillProgress, SessionItem } from './training/scheduler';
import type { GameSummary } from './types';

type View = 'list' | 'train' | 'drilling';

export default function App() {
  const { username, connect, disconnect } = useConnectedUser();
  const coach = useCoachPack(); // also picks up a ?coach= link, even before connecting
  const [selected, setSelected] = useState<GameSummary | null>(null);
  const [view, setView] = useState<View>('list');
  const [session, setSession] = useState<{ id: number; items: SessionItem[]; progress: Map<string, DrillProgress> } | null>(
    null,
  );

  if (!username) {
    return <ConnectScreen onConnect={connect} />;
  }

  if (selected) {
    return (
      <ReviewScreen game={selected} myUsername={username} onBack={() => setSelected(null)} />
    );
  }

  if (view === 'drilling' && session) {
    return (
      <DrillScreen
        key={session.id}
        items={session.items}
        progress={session.progress}
        onDone={() => {
          setSession(null);
          setView('train');
        }}
      />
    );
  }

  if (view === 'train' && coach.url) {
    return (
      <TrainHome
        coach={coach}
        onBack={() => setView('list')}
        onStart={(items, progress) => {
          setSession({ id: Date.now(), items, progress });
          setView('drilling');
        }}
      />
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
      onTrain={coach.url ? () => setView('train') : undefined}
      onLinkCoach={(url) => {
        const ok = coach.link(url);
        if (ok) setView('train');
        return ok;
      }}
    />
  );
}
