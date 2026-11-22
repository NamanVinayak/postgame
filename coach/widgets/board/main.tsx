import { App, applyDocumentTheme, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';
// Pure module (no node imports): the same checker the tests cover.
import { parseCoachView, type CoachView } from '../../src/server/views';
import { AnswerBoard } from './AnswerBoard';
import { QuestionBoard } from './QuestionBoard';
import { ReportCard } from './ReportCard';
import { errorText, resultText } from './shared';
import './widget.css';

type Status = { kind: 'waiting' } | { kind: 'error'; message: string } | { kind: 'ready'; view: CoachView };

function Widget({ app, status }: { app: App; status: Status }) {
  return (
    <div className="pg-wrap">
      {status.kind === 'waiting' && <p className="pg-p pg-muted">Waiting for the coach…</p>}
      {status.kind === 'error' && <p className="pg-p pg-error">Board error: {status.message}</p>}
      {status.kind === 'ready' && status.view.kind === 'answer' && <AnswerBoard view={status.view} />}
      {status.kind === 'ready' && status.view.kind === 'question' && <QuestionBoard app={app} view={status.view} />}
      {status.kind === 'ready' && status.view.kind === 'report' && <ReportCard view={status.view} />}
    </div>
  );
}

const app = new App({ name: 'Postgame Coach board', version: '0.2.0' });
const root = createRoot(document.getElementById('root')!);
let shown = 0;
// A new key per tool result, so a new position starts from a fresh board state.
const show = (status: Status) => root.render(<Widget key={++shown} app={app} status={status} />);

function applyHostContext(ctx: Partial<McpUiHostContext> | undefined) {
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
  const view = parseCoachView(result.structuredContent);
  show(view ? { kind: 'ready', view } : { kind: 'error', message: 'the tool result has nothing to show' });
};
app.onhostcontextchanged = applyHostContext;

app
  .connect()
  .then(() => applyHostContext(app.getHostContext()))
  .catch((err: unknown) => show({ kind: 'error', message: `could not connect to the host: ${errorText(err)}` }));
