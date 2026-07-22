import { useState } from 'react';
import { createStockfishEngine } from './services/engine/stockfishEngine';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// TEMPORARY engine-verification harness (Task 8). Removed once confirmed.
export default function App() {
  const [out, setOut] = useState('(idle)');

  async function run() {
    setOut('evaluating…');
    try {
      const engine = createStockfishEngine();
      const evaluation = await engine.evaluate(START_FEN, 500);
      setOut(JSON.stringify(evaluation));
      engine.terminate();
    } catch (err) {
      setOut('ERROR: ' + (err as Error).message);
    }
  }

  return (
    <div className="app-shell">
      <h1>Postgame</h1>
      <button id="engine-test" onClick={run}>
        Test engine
      </button>
      <pre id="engine-out">{out}</pre>
    </div>
  );
}
