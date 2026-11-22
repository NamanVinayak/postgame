/**
 * Postgame Coach MCP server (stdio). Claude Desktop launches it as
 *   node coach/node_modules/tsx/dist/cli.mjs coach/src/server/server.ts
 * with a bare PATH, so Stockfish is found by absolute path (STOCKFISH_PATH, or the local config).
 *
 * At most two Stockfish processes per server: the background analysis engine (ENGINE_CFG,
 * owned by the runner) and the board engine (DISPLAY_CFG), each started on first use. Another
 * process (e.g. `npm run prewarm`) may run its own Stockfish at the same time.
 *
 * Fails at startup, before anything else, if the board widget is not built
 * (coach/dist/board.html): "run `npm run build:widgets` in coach/".
 *
 * Nothing may be written to stdout except MCP messages; logs go to stderr.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseFreeMemoryPct } from '../analysis/memoryPressure';
import { createRunner } from '../analysis/runner';
import { DISPLAY_CFG, loadLocalConfig } from '../config';
import { createNativeStockfish, type NativeStockfish } from '../engine/nativeStockfish';
import { createChesscomSource } from '../sources/chesscom';
import { registerBoardResource } from './boardResource';
import { registerCoachTools, type DisplayEngine } from './tools';

const NAME = 'postgame-coach';

function freeMemoryPct(): number | null {
  try {
    return parseFreeMemoryPct(execFileSync('/usr/bin/memory_pressure', { encoding: 'utf8', timeout: 5000 }));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const server = new McpServer({ name: NAME, version: '0.1.0' });
  // Throws "... run `npm run build:widgets` in coach/" when the widget is missing.
  registerBoardResource(server);

  let closing = false;

  // Background analysis engine: the runner creates it lazily, and again if it dies.
  let analysis: NativeStockfish | null = null;
  let analysedBefore = 0;
  const runner = createRunner(() => {
    if (closing) throw new Error('The coach server is shutting down');
    analysedBefore += analysis?.positionsSearched() ?? 0;
    return (analysis = createNativeStockfish());
  }, createChesscomSource());

  // Board engine: deep search for every position shown, one instance, created on first use.
  let board: NativeStockfish | null = null;
  let boardSearchedBefore = 0;
  const display: DisplayEngine = {
    get() {
      if (closing) throw new Error('The coach server is shutting down');
      board ??= createNativeStockfish({ movetimeMs: DISPLAY_CFG.movetimeMs, multiPv: DISPLAY_CFG.multiPv });
      return board;
    },
    reset(failed) {
      if (!board || board !== failed) return; // already replaced by a newer engine
      const old = board;
      board = null;
      boardSearchedBefore += old.positionsSearched();
      void old.close().catch(() => undefined);
    },
  };

  registerCoachTools(server, {
    runner,
    display,
    freeMemoryPct,
    engineInfo() {
      const stockfishPath = loadLocalConfig().stockfishPath;
      return {
        stockfishPath,
        binaryFound: existsSync(stockfishPath),
        analysis: {
          running: (analysis?.pid() ?? null) !== null,
          positionsSearched: analysedBefore + (analysis?.positionsSearched() ?? 0),
        },
        display: {
          running: (board?.pid() ?? null) !== null,
          positionsSearched: boardSearchedBefore + (board?.positionsSearched() ?? 0),
        },
      };
    },
  });

  /**
   * Stops both Stockfish processes and exits. Doesn't wait for the runner's queue (a running
   * job could take minutes): closing its engine makes the job fail, and the factory refuses to
   * build a new one. Analysed games are already cached, so nothing is lost.
   */
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    const engines = [analysis, board].filter((e): e is NativeStockfish => e !== null);
    await Promise.race([
      Promise.allSettled(engines.map((e) => e.close())),
      new Promise((r) => setTimeout(r, 3000).unref()),
    ]);
    process.exit(0);
  }
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  server.server.onclose = () => void shutdown();

  await server.connect(new StdioServerTransport());
  console.error(`${NAME}: running on stdio`);
}

main().catch((err: unknown) => {
  console.error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
