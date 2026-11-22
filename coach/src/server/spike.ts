/**
 * Widget spike (plan Tasks A1 and A2): a stdio MCP server whose only job is to show the board
 * widget inside Claude Desktop through MCP Apps, in all three of its views (answer, question,
 * report card), plus a stub of the move check the coach calls after a question. Not the real coach server:
 * every position, move and number here is fixed test data, not engine or diagnosis output.
 *
 * Run: node coach/node_modules/tsx/dist/cli.mjs coach/src/server/spike.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { Chess } from 'chess.js';
import { z } from 'zod';
import type { PositionFacts } from '../coaching/positionFacts';
import { BOARD_URI, registerBoardResource } from './boardResource';
import { toAnswerView, toQuestionView, toReportView, type Attempt, type CoachView, type DiagnosisLike } from './views';

// The three position values below are fixed by the plan. Everything else is spike filler:
// the win % numbers, the refutation and the report rows are placeholders, not engine output.
const SPIKE_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const SPIKE_PLAYED_UCI = 'g8f6';
const SPIKE_BEST_UCI = 'f8c5';
const SPIKE_BEST_LINE_UCI = ['f8c5', 'c2c3', 'g8f6', 'd2d4'];
const SPIKE_GAME_ID = 'spike-game';
const SPIKE_PLY = 5; // 0-based: Black's 3rd move
const PLACEHOLDER_WIN_BEFORE = 50;
const PLACEHOLDER_WIN_AFTER = 41;
const PLACEHOLDER_REFUTATION_AFTER_NF6 = ['Ng5', 'd5', 'exd5'];
const SPIKE_PROMPT = 'What would you play here, and what were you worried about?';
const SPIKE_NOTE = '(Spike test data: these numbers are placeholders, not engine output.)';

/** SAN for each UCI move played in order from `fen`; throws on an illegal move. */
function uciLineToSan(fen: string, uciMoves: string[]): string[] {
  const chess = new Chess(fen);
  return uciMoves.map((uci) => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
}

/** UCI for a SAN or UCI move in the spike position, or null if it is illegal there. */
function spikeAttempt(move: string): Attempt | null {
  const chess = new Chess(SPIKE_FEN);
  try {
    const m = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)
      ? chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
      : chess.move(move);
    return { moveSan: m.san, moveUci: m.from + m.to + (m.promotion ?? '') };
  } catch {
    return null;
  }
}

/** Spike PositionFacts for the game move (Nf6); Bc5 is the "best" move by fiat. */
function spikeFacts(): PositionFacts {
  const chess = new Chess(SPIKE_FEN);
  const played = chess.move({ from: SPIKE_PLAYED_UCI.slice(0, 2), to: SPIKE_PLAYED_UCI.slice(2, 4) });
  const bestLineSan = uciLineToSan(SPIKE_FEN, SPIKE_BEST_LINE_UCI);
  return {
    gameId: SPIKE_GAME_ID,
    ply: SPIKE_PLY,
    fenBefore: SPIKE_FEN,
    fenAfter: chess.fen(),
    mover: 'black',
    playedSan: played.san,
    playedUci: SPIKE_PLAYED_UCI,
    bestSan: bestLineSan[0],
    bestUci: SPIKE_BEST_UCI,
    bestLineSan,
    refutationSan: PLACEHOLDER_REFUTATION_AFTER_NF6,
    winBefore: PLACEHOLDER_WIN_BEFORE,
    winAfter: PLACEHOLDER_WIN_AFTER,
    classification: 'mistake',
    reason: null,
    gameUrl: 'https://www.chess.com/',
  };
}

/** The answer view for the spike position, with the caption marked as test data. */
function spikeAnswer(f: PositionFacts, attempt?: Attempt): CoachView {
  const view = toAnswerView(f, attempt);
  return view.kind === 'answer' ? { ...view, caption: `${view.caption} ${SPIKE_NOTE}` } : view;
}

// Six made-up rows covering all four labels, shaped like B4's Diagnosis.
const SPIKE_DIAGNOSIS: DiagnosisLike = {
  timeClass: 'blitz',
  games: 300,
  areas: [
    { area: 'opening', label: 'notYourProblem', myRate: 2.1, oppRate: 2.4, gapPts: -0.3, ci95: [-1.2, 0.6], games: 300 },
    { area: 'middlegame', label: 'noClearDifference', myRate: 6.8, oppRate: 5.9, gapPts: 0.9, ci95: [-0.4, 2.3], games: 296 },
    { area: 'endgame', label: 'gap', myRate: 9.4, oppRate: 5.6, gapPts: 3.8, ci95: [2.2, 5.5], ciAdj: [1.3, 6.4], games: 141 },
    { area: 'converting', label: 'notYourProblem', myRate: 3.2, oppRate: 3.9, gapPts: -0.7, ci95: [-2.0, 0.6], games: 118 },
    { area: 'defending', label: 'noClearDifference', myRate: 11.5, oppRate: 10.2, gapPts: 1.3, ci95: [-1.1, 3.8], games: 97 },
    { area: 'timePressure', label: 'notEnoughData', myRate: 15, oppRate: 12, gapPts: 3, ci95: [-6, 12], games: 19 },
  ],
  focus: { kind: 'area', area: 'endgame' },
};
const SPIKE_HEADLINE = 'Spike sample, not your games: endgames are where points slip away.';

function buildServer(): McpServer {
  const server = new McpServer({ name: 'postgame-coach-spike', version: '0.2.0' });

  registerBoardResource(server);

  registerAppTool(
    server,
    'coach_ping_board',
    {
      title: 'Ping the board (answer view)',
      description:
        'Test tool for the Postgame Coach board widget. Shows a fixed chess position with the move played and the best move. Use it when the user says "ping the board".',
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async () => {
      const facts = spikeFacts();
      const view = spikeAnswer(facts);
      const text =
        `Board test position (${facts.mover} to move): ${facts.fenBefore}. ` +
        `Played ${facts.playedSan} (${facts.playedUci}); best ${facts.bestSan} (${facts.bestUci}). ` +
        `Best line: ${facts.bestLineSan?.join(' ')}. Win % numbers are placeholders.`;
      return { content: [{ type: 'text', text }], structuredContent: { ...view } };
    },
  );

  registerAppTool(
    server,
    'coach_ping_question',
    {
      title: 'Ping the board (question view)',
      description:
        'Test tool for the Postgame Coach board widget. Shows a fixed position as a question with no answer, for the user to play a move on the board. Use it when the user says "ping the question". Do not tell the user the best move.',
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async () => {
      const view = toQuestionView(spikeFacts(), SPIKE_PROMPT);
      const text = `Question board test: Black to move in ${SPIKE_FEN} (game ${SPIKE_GAME_ID}, ply ${SPIKE_PLY}). Ask: ${SPIKE_PROMPT}`;
      return { content: [{ type: 'text', text }], structuredContent: { ...view } };
    },
  );

  registerAppTool(
    server,
    'coach_ping_report',
    {
      title: 'Ping the board (report card)',
      description:
        'Test tool for the Postgame Coach board widget. Shows a report card filled with made-up sample rows (not the user\'s games). Use it when the user says "ping the report".',
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async () => {
      const view = toReportView(SPIKE_DIAGNOSIS, SPIKE_HEADLINE);
      const text = 'Report card test with made-up sample rows (not real games): endgames marked as the weak spot, focus endgames.';
      return { content: [{ type: 'text', text }], structuredContent: { ...view } };
    },
  );

  // SPIKE STUB of the real coach_check_move (plan Task C1b). The question board never calls it
  // (try-first is strict); the coach calls it after the player has said why, and its result
  // shows the answer board with the player's attempt as "your move". It scores nothing: Bc5 is
  // "best" by fiat, the game move is Nf6 and the win % are placeholders.
  registerAppTool(
    server,
    'coach_check_move',
    {
      title: 'Check a move (spike stub)',
      description:
        'SPIKE STUB for the Postgame Coach board widget. After the user has played a move on the "ping the question" board and said why they chose it, call this with that move to show the answer board. Fixed test data, no engine.',
      inputSchema: {
        gameId: z.string().describe('Game id from the question view'),
        ply: z.number().int().describe('Ply from the question view'),
        moveSan: z.string().describe('The move the user played, in SAN'),
        username: z.string().optional().describe('Player username (unused by the stub)'),
      },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ gameId, ply, moveSan }) => {
      if (gameId !== SPIKE_GAME_ID || ply !== SPIKE_PLY) {
        return { isError: true, content: [{ type: 'text', text: `Spike stub only knows ${SPIKE_GAME_ID} ply ${SPIKE_PLY}.` }] };
      }
      const attempt = spikeAttempt(moveSan);
      if (!attempt) {
        return { isError: true, content: [{ type: 'text', text: `${moveSan} is not a legal move in this position.` }] };
      }
      const facts = spikeFacts();
      const view = spikeAnswer(facts, attempt);
      const verdict = attempt.moveUci === SPIKE_BEST_UCI ? 'the best move (spike answer)' : `not the spike answer; best is ${facts.bestSan}`;
      const text =
        `Spike check: ${attempt.moveSan} is ${verdict}. In the game the move was ${facts.playedSan} ` +
        `(win % ${facts.winBefore} → ${facts.winAfter}, placeholders).`;
      return { content: [{ type: 'text', text }], structuredContent: { ...view } };
    },
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
