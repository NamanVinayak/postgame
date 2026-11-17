import type { Evaluation, Engine, SecondBestLine } from './types';
import { parseBestmove, parseUciInfo } from './uci';
import { ENGINE } from '../../constants';

/** Served from public/stockfish/ (copied there by scripts/copy-stockfish.mjs). */
const ENGINE_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-18-lite-single.js`;

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
        worker.postMessage(`setoption name MultiPV value ${ENGINE.multiPV}`);
        await waitFor((l) => l === 'readyok', 'isready');
      })();
    }
    return ready;
  }

  function search(fen: string, movetimeMs: number): Promise<Evaluation> {
    return new Promise((resolve) => {
      /** Latest score for each MultiPV tier: [1] is best, [2] the second-best line. */
      const tiers: Record<
        number,
        { cp: number | null; mate: number | null; pv?: string[] | null }
      > = {};

      const handler = (event: MessageEvent) => {
        for (const line of lines(event.data)) {
          if (!line) continue;
          const info = parseUciInfo(line);
          if (info) {
            tiers[info.tier] = { cp: info.cp, mate: info.mate, pv: info.pv };
            continue;
          }
          if (line.startsWith('bestmove')) {
            const top = tiers[1] ?? { cp: null, mate: null };
            const bestMoveUci = parseBestmove(line);
            let secondBest: SecondBestLine | null = null;
            if (tiers[2]) {
              secondBest = {
                cp: tiers[2].cp,
                mate: tiers[2].mate,
                bestMoveUci: tiers[2].pv && tiers[2].pv[0] ? tiers[2].pv[0] : null,
              };
            }
            worker.removeEventListener('message', handler);
            resolve({
              cp: top.cp,
              mate: top.mate,
              bestMoveUci,
              secondBest,
              pvUci: top.pv ?? null,
            });
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
