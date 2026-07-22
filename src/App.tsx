import { useConnectedUser } from './hooks/useConnectedUser';

// App routing is completed in Task 12 (wires ConnectScreen / GameList / ReviewScreen).
export default function App() {
  const { username, disconnect } = useConnectedUser();

  return (
    <div className="app-shell">
      <h1>Postgame</h1>
      {username ? (
        <p>
          Connected as {username}.{' '}
          <button onClick={disconnect}>Disconnect</button>
        </p>
      ) : (
        <p>No account connected.</p>
      )}
    </div>
  );
}
