import { App, applyDocumentTheme, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Chessboard } from 'react-chessboard';
// Type-only: keeps the server's node:fs code out of the bundle.
import type { BoardView } from '../../src/server/boardResource';

const PLAYED_ARROW = 'rgba(207, 34, 46, 0.85)';
const BEST_ARROW = 'rgba(26, 127, 55, 0.85)';
const SQUARES = { dark: '#6f7d5a', light: '#e9e6d6' }; // same as the Postgame web app
const SPIKE_CHAT_TEXT = 'Board test: I would play Bc5 here.';

type Status =
  | { kind: 'waiting' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; view: BoardView };

const isStr = (x: unknown): x is string => typeof x === 'string';
const isStrOrNull = (x: unknown) => x === null || isStr(x);
const isNumOrNull = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x));

/** Checks the tool result's structuredContent; returns null if it isn't a BoardView. */
function toBoardView(x: unknown): BoardView | null {
  if (typeof x !== 'object' || x === null) return null;
  const v = x as Record<string, unknown>;
  const ok =
    isStr(v.fen) &&
    (v.orientation === 'white' || v.orientation === 'black') &&
    isStrOrNull(v.playedUci) &&
    isStrOrNull(v.bestUci) &&
    isStrOrNull(v.playedSan) &&
    isStrOrNull(v.bestSan) &&
    isNumOrNull(v.winBefore) &&
    isNumOrNull(v.winAfter) &&
    (v.bestLineSan === null || (Array.isArray(v.bestLineSan) && v.bestLineSan.every(isStr))) &&
    isStr(v.caption);
  return ok ? (v as unknown as BoardView) : null;
}

/** A react-chessboard arrow for a UCI move such as "g8f6" or "e7e8q". */
function arrowFor(uci: string | null, color: string) {
  if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  return { startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color };
}

/** Text of every text block in a tool result. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && isStr(c.text))
    .map((c) => c.text)
    .join('\n');
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const styles = {
  wrap: { padding: 12, maxWidth: 420, boxSizing: 'border-box' },
  board: { width: '100%', maxWidth: 400 },
  caption: { margin: '10px 0 4px' },
  muted: { margin: '2px 0', color: 'var(--pg-muted)' },
  played: { color: PLAYED_ARROW, fontWeight: 600 },
  best: { color: BEST_ARROW, fontWeight: 600 },
  buttons: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 },
  button: {
    font: 'inherit',
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid var(--pg-border)',
    background: 'var(--pg-button-bg)',
    color: 'var(--pg-text)',
    cursor: 'pointer',
  },
  out: { margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
} satisfies Record<string, CSSProperties>;

function Board({ view }: { view: BoardView }) {
  const played = arrowFor(view.playedUci, PLAYED_ARROW);
  const best = arrowFor(view.bestUci, BEST_ARROW);
  // If the played move was the best move, show only the green arrow.
  const arrows = [view.playedUci !== view.bestUci ? played : null, best].filter((a) => a !== null);
  const win =
    view.winBefore !== null && view.winAfter !== null
      ? `Your win chance: ${Math.round(view.winBefore)}% before, ${Math.round(view.winAfter)}% after`
      : null;
  return (
    <>
      <div style={styles.board}>
        <Chessboard
          options={{
            id: 'postgame-coach-board',
            position: view.fen,
            boardOrientation: view.orientation,
            arrows,
            allowDragging: false,
            allowDrawingArrows: false,
            showNotation: true,
            darkSquareStyle: { backgroundColor: SQUARES.dark },
            lightSquareStyle: { backgroundColor: SQUARES.light },
          }}
        />
      </div>
      <p style={styles.caption}>{view.caption}</p>
      {(view.playedSan || view.bestSan) && (
        <p style={styles.muted}>
          {view.playedSan && <span style={styles.played}>Played {view.playedSan}</span>}
          {view.playedSan && view.bestSan && ' · '}
          {view.bestSan && <span style={styles.best}>Best {view.bestSan}</span>}
        </p>
      )}
      {win && <p style={styles.muted}>{win}</p>}
      {view.bestLineSan && view.bestLineSan.length > 0 && (
        <p style={styles.muted}>Best line: {view.bestLineSan.join(' ')}</p>
      )}
    </>
  );
}

/** Spike-only buttons proving the board can talk back to the chat and to the server. */
function TalkBack({ app, fen }: { app: App; fen: string }) {
  const [chatOut, setChatOut] = useState<string | null>(null);
  const [engineOut, setEngineOut] = useState<string | null>(null);

  const sendToChat = async () => {
    setChatOut('sending…');
    try {
      const res = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: SPIKE_CHAT_TEXT }] });
      setChatOut(res.isError ? 'error: the host rejected the message' : 'sent ✓');
    } catch (err) {
      setChatOut(`error: ${errorText(err)}`);
    }
  };

  const askEngine = async () => {
    setEngineOut('asking…');
    try {
      const res = await app.callServerTool({ name: 'coach_ping_eval', arguments: { fen } });
      const text = resultText(res.content) || '(no text returned)';
      setEngineOut(res.isError ? `error: ${text}` : text);
    } catch (err) {
      setEngineOut(`error: ${errorText(err)}`);
    }
  };

  return (
    <>
      <div style={styles.buttons}>
        <button type="button" style={styles.button} onClick={sendToChat}>
          Send to chat
        </button>
        <button type="button" style={styles.button} onClick={askEngine}>
          Ask the engine
        </button>
      </div>
      {chatOut && <p style={styles.out}>Send to chat: {chatOut}</p>}
      {engineOut && <p style={styles.out}>Ask the engine: {engineOut}</p>}
    </>
  );
}

function Widget({ app, status }: { app: App; status: Status }) {
  return (
    <div style={styles.wrap}>
      {status.kind === 'waiting' && <p style={styles.muted}>Waiting for the position…</p>}
      {status.kind === 'error' && <p style={styles.out}>Board error: {status.message}</p>}
      {status.kind === 'ready' && (
        <>
          <Board view={status.view} />
          <TalkBack app={app} fen={status.view.fen} />
        </>
      )}
    </div>
  );
}

const app = new App({ name: 'Postgame Coach board', version: '0.1.0' });
const root = createRoot(document.getElementById('root')!);
const show = (status: Status) => root.render(<Widget app={app} status={status} />);

function applyHostContext(ctx: McpUiHostContext | undefined) {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
}

// Render something visible first so the frame never has zero height.
show({ kind: 'waiting' });

// Handlers go on before connect() so the first tool result is not missed.
app.ontoolresult = (result) => {
  if (result.isError) {
    show({ kind: 'error', message: resultText(result.content) || 'the tool reported an error' });
    return;
  }
  const view = toBoardView(result.structuredContent);
  show(view ? { kind: 'ready', view } : { kind: 'error', message: 'the tool result has no board data' });
};
app.onhostcontextchanged = applyHostContext;

app
  .connect()
  .then(() => applyHostContext(app.getHostContext()))
  .catch((err: unknown) => show({ kind: 'error', message: `could not connect to the host: ${errorText(err)}` }));
