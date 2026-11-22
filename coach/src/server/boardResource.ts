import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RESOURCE_MIME_TYPE, registerAppResource } from '@modelcontextprotocol/ext-apps/server';

/**
 * The ui:// resource for the coach widget inside an MCP Apps host. One widget, three views
 * (answer board, question board, report card), switched by `structuredContent.kind`; see
 * views.ts for `CoachView` and the mappers that build it.
 */
export const BOARD_URI = 'ui://postgame-coach/board';

/**
 * What the answer board draws. Tools linked to BOARD_URI return it as `structuredContent`
 * inside a `CoachView` of kind 'answer' (views.ts). `bestUci`/`bestSan` are null when the
 * played move was the best one; the board then draws the played move in green.
 */
export interface BoardView {
  fen: string;
  orientation: 'white' | 'black';
  playedUci: string | null;
  bestUci: string | null;
  playedSan: string | null;
  bestSan: string | null;
  winBefore: number | null;
  winAfter: number | null;
  bestLineSan: string[] | null;
  caption: string;
}

// Resolved from this file, not the working directory: Claude Desktop launches the server elsewhere.
const BOARD_HTML_PATH = fileURLToPath(new URL('../../dist/board.html', import.meta.url));

/**
 * Serves the bundled widget (coach/dist/board.html) at BOARD_URI with the MCP App MIME type.
 * Everything is inlined in that file, so no CSP domains are declared. Throws if the widget
 * has not been built. The file is re-read on every request so a rebuild needs no restart.
 */
export function registerBoardResource(server: McpServer): void {
  if (!existsSync(BOARD_HTML_PATH)) {
    throw new Error(`Board widget not found at ${BOARD_HTML_PATH}: run \`npm run build:widgets\` in coach/`);
  }
  registerAppResource(
    server,
    'Postgame Coach board',
    BOARD_URI,
    {
      description:
        'Postgame Coach board: a position with the move played and the engine best move, a position to try a move in, or a report card',
    },
    async () => ({
      contents: [{ uri: BOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: readFileSync(BOARD_HTML_PATH, 'utf8') }],
    }),
  );
}
