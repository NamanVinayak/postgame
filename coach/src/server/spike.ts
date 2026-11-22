/**
 * Widget spike (plan Task A1): a stdio MCP server whose only job is to prove that a chess
 * board renders inside Claude Desktop through MCP Apps, and that the board can talk back
 * (send a chat message, call a server tool). Not the real coach server.
 *
 * Run: node coach/node_modules/tsx/dist/cli.mjs coach/src/server/spike.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { Chess } from 'chess.js';
import { z } from 'zod';
import { BOARD_URI, registerBoardResource, type BoardView } from './boardResource';

// The three position values below are fixed by the plan. Everything else is spike filler:
// the win % numbers are placeholders, not engine output.
const SPIKE_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const SPIKE_PLAYED_UCI = 'g8f6';
const SPIKE_BEST_UCI = 'f8c5';
const SPIKE_BEST_LINE_UCI = ['f8c5', 'c2c3', 'g8f6', 'd2d4'];
const PLACEHOLDER_WIN_BEFORE = 50;
const PLACEHOLDER_WIN_AFTER = 48;

/** SAN for each UCI move played in order from `fen`; throws on an illegal move. */
function uciLineToSan(fen: string, uciMoves: string[]): string[] {
  const chess = new Chess(fen);
  return uciMoves.map((uci) => {
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return move.san;
  });
}

function spikeBoardView(): BoardView {
  const [playedSan] = uciLineToSan(SPIKE_FEN, [SPIKE_PLAYED_UCI]);
  const bestLineSan = uciLineToSan(SPIKE_FEN, SPIKE_BEST_LINE_UCI);
  return {
    fen: SPIKE_FEN,
    orientation: 'black',
    playedUci: SPIKE_PLAYED_UCI,
    bestUci: SPIKE_BEST_UCI,
    playedSan,
    bestSan: bestLineSan[0],
    winBefore: PLACEHOLDER_WIN_BEFORE,
    winAfter: PLACEHOLDER_WIN_AFTER,
    bestLineSan,
    caption: `Widget spike: you played ${playedSan} (red arrow); the test answer is ${bestLineSan[0]} (green arrow). Win % numbers are placeholders, not engine output.`,
  };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'postgame-coach-spike', version: '0.1.0' });

  registerBoardResource(server);

  registerAppTool(
    server,
    'coach_ping_board',
    {
      title: 'Ping the board',
      description:
        'Test tool for the Postgame Coach board widget. Shows a fixed chess position with the move played and the best move. Use it when the user says "ping the board".',
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async () => {
      const view = spikeBoardView();
      const text =
        `Board test position (${view.orientation} to move): ${view.fen}. ` +
        `Played ${view.playedSan} (${view.playedUci}); best ${view.bestSan} (${view.bestUci}). ` +
        `Best line: ${view.bestLineSan?.join(' ')}. Win % numbers are placeholders.`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...view },
      };
    },
  );

  // Called from the widget's "Ask the engine" button to prove the widget -> server round trip.
  // No engine involved; it only echoes the FEN.
  server.registerTool(
    'coach_ping_eval',
    {
      title: 'Ping the engine (round-trip test)',
      description:
        'Test tool for the Postgame Coach board widget: echoes the FEN to prove the widget can call the server. Does not run an engine.',
      inputSchema: { fen: z.string().describe('Position in FEN') },
    },
    async ({ fen }) => ({ content: [{ type: 'text', text: `engine reachable: ${fen}` }] }),
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error('postgame-coach-spike: running on stdio');
}

main().catch((err: unknown) => {
  console.error(`postgame-coach-spike: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
