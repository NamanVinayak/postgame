import { useEffect, useState } from 'react';
import { useConnectedUser } from './hooks/useConnectedUser';
import { ConnectScreen } from './components/ConnectScreen';
import { GameList } from './components/GameList';
import { ReviewScreen } from './components/ReviewScreen';
import { TrainHome } from './components/train/TrainHome';
import { DrillScreen } from './components/train/DrillScreen';
import { useCoachPack } from './training/useCoachPack';
import { holdReloadWhileVisible } from './pwa/updates';
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

  // A new app version reloads into the game list (there is no routing), so while a review,
  // the training home or a drill is on screen it waits until the app is in the background.
  const onGameListOrConnect =
    !username || (!selected && !(view === 'drilling' && session) && !(view === 'train' && coach.url));
  useEffect(() => (onGameListOrConnect ? undefined : holdReloadWhileVisible()), [onGameListOrConnect]);

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
