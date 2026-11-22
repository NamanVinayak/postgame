/**
 * Postgame Coach MCP server (stdio). Claude Desktop launches it as
 *   node coach/node_modules/tsx/dist/cli.mjs coach/src/server/server.ts
 * with a bare PATH, so Stockfish is found by absolute path (STOCKFISH_PATH, or the local config).
 *
 * At most two Stockfish processes per server: the background analysis engine (ENGINE_CFG,
 * owned by the runner) and the board engine (DISPLAY_CFG), each started on first use. Every
 * start of the analysis engine first checks free memory (Mac limits), so a diagnosis of games
 * that are already cached never needs, or is refused, an engine. Another process (e.g.
 * `npm run prewarm`) may run its own Stockfish at the same time.
 *
 * Fails at startup, before anything else, if the board widget is not built
 * (coach/dist/board.html): "run `npm run build:widgets` in coach/".
 *
 * Nothing may be written to stdout except MCP messages; logs go to stderr.
 */
import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { memoryGuarded } from '../analysis/memoryPressure';
import { createRunner } from '../analysis/runner';
import { loadLocalConfig } from '../config';
import { createDisplayEngine, type DisplayEngine } from '../engine/displayEngine';
import { createNativeStockfish, type NativeStockfish } from '../engine/nativeStockfish';
import { createChesscomSource } from '../sources/chesscom';
import { registerBoardResource } from './boardResource';
import { registerCoachTools, type DisplaySlot } from './tools';

const NAME = 'postgame-coach';

async function main(): Promise<void> {
  const server = new McpServer({ name: NAME, version: '0.1.0' });
  // Throws "... run `npm run build:widgets` in coach/" when the widget is missing.
  registerBoardResource(server);

  let closing = false;

  // Background analysis engine: the runner creates it lazily (only for games not cached yet),
  // and again if it dies. A refusal (shutting down, low memory) surfaces as the job's error.
  let analysis: NativeStockfish | null = null;
  let analysedBefore = 0;
  const runner = createRunner(
    memoryGuarded(() => {
      if (closing) throw new Error('the coach server is shutting down');
      analysedBefore += analysis?.positionsSearched() ?? 0;
      return (analysis = createNativeStockfish());
    }),
    createChesscomSource(),
  );

  // Board engine: deep search for every position shown, one instance, created on first use.
  let board: DisplayEngine<NativeStockfish> | null = null;
  let boardSearchedBefore = 0;
  const display: DisplaySlot = {
    get() {
      if (closing) throw new Error('the coach server is shutting down');
      board ??= createDisplayEngine();
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
