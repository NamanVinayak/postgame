import type { Engine, Evaluation } from './types';

/** Served from public/stockfish/ (copied there by scripts/copy-stockfish.mjs). */
const ENGINE_URL = '/stockfish/stockfish-18-lite-single.js';

export interface StockfishEngine extends Engine {
  /** Release the underlying Web Worker. */
  terminate(): void;
}

function lines(data: unknown): string[] {
  const text = typeof data === 'string' ? data : String(data ?? '');
  return text.split('\n');
}

/**
 * A real Engine backed by single-threaded Stockfish WASM in a Web Worker.
 * Calls are serialized (one search at a time). Scores are side-to-move POV,
 * matching the Evaluation contract.
 */
export function createStockfishEngine(): StockfishEngine {
  const worker = new Worker(ENGINE_URL);
  let ready: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  function waitFor(isDone: (line: string) => boolean, command?: string): Promise<void> {
    return new Promise((resolve) => {
      const handler = (event: MessageEvent) => {
        for (const line of lines(event.data)) {
          if (line && isDone(line)) {
            worker.removeEventListener('message', handler);
            resolve();
            return;
          }
        }
      };
      worker.addEventListener('message', handler);
      if (command) worker.postMessage(command);
    });
  }

  function ensureReady(): Promise<void> {
    if (!ready) {
      ready = (async () => {
        await waitFor((l) => l === 'uciok', 'uci');
        await waitFor((l) => l === 'readyok', 'isready');
      })();
    }
    return ready;
  }

  function search(fen: string, movetimeMs: number): Promise<Evaluation> {
    return new Promise((resolve) => {
      let cp: number | null = null;
      let mate: number | null = null;
      let bestMoveUci: string | null = null;

      const handler = (event: MessageEvent) => {
        for (const line of lines(event.data)) {
          if (!line) continue;
          if (line.startsWith('info') && line.includes(' score ')) {
            const m = /score (cp|mate) (-?\d+)/.exec(line);
            if (m) {
              if (m[1] === 'cp') {
                cp = parseInt(m[2], 10);
                mate = null;
              } else {
                mate = parseInt(m[2], 10);
                cp = null;
              }
            }
          } else if (line.startsWith('bestmove')) {
            const parts = line.trim().split(/\s+/);
            bestMoveUci = parts[1] && parts[1] !== '(none)' ? parts[1] : null;
            worker.removeEventListener('message', handler);
            resolve({ cp, mate, bestMoveUci });
            return;
          }
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go movetime ${movetimeMs}`);
    });
  }

  async function evaluate(fen: string, movetimeMs: number): Promise<Evaluation> {
    await ensureReady();
    const run = chain.then(() => search(fen, movetimeMs));
    chain = run.catch(() => undefined);
    return run;
  }

  return {
    evaluate,
    terminate: () => worker.terminate(),
  };
}
