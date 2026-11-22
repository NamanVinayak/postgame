import { App, applyDocumentTheme, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';
// Pure module (no node imports): the same checker the tests cover.
import { parseCoachView, type CoachView } from '../../src/server/views';
import { AnswerBoard } from './AnswerBoard';
import { QuestionBoard } from './QuestionBoard';
import { ReportCard, type Display } from './ReportCard';
import { StatusCard } from './StatusCard';
import { errorText, resultText } from './shared';
import './widget.css';

type Status = { kind: 'waiting' } | { kind: 'error'; message: string } | { kind: 'ready'; view: CoachView };

interface WidgetProps {
  app: App;
  status: Status;
  display: Display;
  onDisplayMode: (mode: NonNullable<Display['mode']>) => void;
}

function Widget({ app, status, display, onDisplayMode }: WidgetProps) {
  // The report and the status card paint their own card, edge to edge.
  const card = status.kind === 'ready' && (status.view.kind === 'report' || status.view.kind === 'status');
  return (
    <div className={card ? 'pg-wrap pg-wrap--report' : 'pg-wrap'}>
      {status.kind === 'waiting' && <p className="pg-p pg-muted">Waiting for the coach…</p>}
      {status.kind === 'error' && <p className="pg-p pg-error">Board error: {status.message}</p>}
      {status.kind === 'ready' && status.view.kind === 'answer' && <AnswerBoard view={status.view} />}
      {status.kind === 'ready' && status.view.kind === 'question' && <QuestionBoard app={app} view={status.view} />}
      {status.kind === 'ready' && status.view.kind === 'report' && (
        <ReportCard app={app} view={status.view} display={display} onDisplayMode={onDisplayMode} />
      )}
      {status.kind === 'ready' && status.view.kind === 'status' && <StatusCard view={status.view} />}
    </div>
  );
}

// The report card can go fullscreen; the host decides whether to offer it.
const app = new App({ name: 'Postgame Coach board', version: '0.3.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });
const root = createRoot(document.getElementById('root')!);

let status: Status = { kind: 'waiting' };
let display: Display = { mode: undefined, available: [] };
// A new key per tool result, so a new position starts from a fresh board state. Host-context
// changes (theme, display mode) re-render with the same key, so nothing on screen resets.
let shown = 0;
const render = () =>
  root.render(<Widget key={shown} app={app} status={status} display={display} onDisplayMode={setDisplayMode} />);
const show = (next: Status) => {
  status = next;
  shown++;
  render();
};

function setDisplayMode(mode: NonNullable<Display['mode']>) {
  if (display.mode === mode) return;
  display = { ...display, mode };
  render();
}

function applyHostContext(ctx: Partial<McpUiHostContext> | undefined) {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  const all = { ...app.getHostContext(), ...ctx };
  display = { mode: all.displayMode ?? display.mode, available: all.availableDisplayModes ?? display.available };
  render();
}

// Render something visible first so the frame never has zero height.
show({ kind: 'waiting' });

// Handlers go on before connect() so the first tool result is not missed.
app.ontoolresult = (result) => {
  if (result.isError) {
    show({ kind: 'error', message: resultText(result.content) || 'the tool reported an error' });
    return;
  }
  const view = parseCoachView(result.structuredContent);
  show(view ? { kind: 'ready', view } : { kind: 'error', message: 'the tool result has nothing to show' });
};
app.onhostcontextchanged = applyHostContext;

app
  .connect()
  .then(() => applyHostContext(app.getHostContext()))
  .catch((err: unknown) => show({ kind: 'error', message: `could not connect to the host: ${errorText(err)}` }));
