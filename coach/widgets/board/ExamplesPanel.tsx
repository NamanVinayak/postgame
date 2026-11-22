import type { App } from '@modelcontextprotocol/ext-apps';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type Ref } from 'react';
import type { ExampleSource } from '../../src/diagnosis/examples';
import type { ExampleRowView, ExamplesView } from '../../src/server/views';
import {
  ExamplesLoader,
  dateText,
  draftTry,
  exampleArrows,
  hasMore,
  isSlowSlip,
  openGame,
  showingText,
  slipText,
  sparkGeometry,
  tryText,
  type DrillRef,
  type ExamplesQuery,
  type ExamplesState,
} from './drill';
import { MiniBoard, toMoveText } from './MiniBoard';
import './report.css';

/**
 * Brings an element on screen now, and again shortly after: inline, the host resizes the frame
 * a moment after the content changes, and only then can the chat scroll to it. Returns a cleanup.
 */
export function reveal(el: HTMLElement, block: ScrollLogicalPosition = 'nearest'): () => void {
  const show = () => el.scrollIntoView?.({ block });
  show();
  const later = [setTimeout(show, 200), setTimeout(show, 600)];
  return () => later.forEach(clearTimeout);
}

/** What a row needs from the host: drafting a chat message and opening a link (either may be missing). */
type RowApp = Partial<Pick<App, 'sendMessage' | 'openLink'>>;

const RESULT = { win: 'Win', draw: 'Draw', loss: 'Loss' } as const;
const PLAYED_SQUARE = 'radial-gradient(circle, rgba(180, 46, 36, 0.5) 0 58%, rgba(180, 46, 36, 0.28) 60%)';
const QUICK = '(quick check)';
const SLOW_SLIP = 'No single costly move in this game (it slipped away slowly or on the clock).';

/**
 * The player's winning chances through one game (the quick check's curve), with the slip marked
 * in red: a dot on its point and the drop into it as a red segment. The dashed line is 50%.
 */
export function Sparkline({ timeline, slipIndex, moveNo }: { timeline: number[]; slipIndex: number; moveNo: number }) {
  const W = 240;
  const H = 48;
  const P = 4;
  const g = sparkGeometry(timeline, slipIndex, W, H, P);
  return (
    <svg
      className="rc-spark"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Your winning chances through the game. The slip at move ${moveNo} is marked in red.`}
    >
      <line className="rc-sparkMid" x1={P} x2={W - P} y1={g.mid.toFixed(1)} y2={g.mid.toFixed(1)} />
      <polyline className="rc-sparkLine" points={g.points} />
      {g.before && (
        <line className="rc-sparkDrop" x1={g.before.x.toFixed(1)} y1={g.before.y.toFixed(1)} x2={g.slip.x.toFixed(1)} y2={g.slip.y.toFixed(1)} />
      )}
      <circle className="rc-sparkSlip" cx={g.slip.x.toFixed(1)} cy={g.slip.y.toFixed(1)} r="3.5" />
    </svg>
  );
}

/**
 * One game: the date, the opponent's rating and the result; "Move 23: 82% → 30% (quick check)";
 * the curve; the board before the move with the played move in red (no answer, nothing green);
 * "Try this position" (drafts the coach request into the chat box) and "Open on Chess.com".
 */
function ExampleCard({ app, row, index, source }: { app: RowApp; row: ExampleRowView; index: number; source: ExampleSource }) {
  const [tried, setTried] = useState<'idle' | 'sending' | 'drafted' | 'failed'>('idle');
  const [link, setLink] = useState<'idle' | 'failed'>('idle');
  const slow = isSlowSlip(source, row);
  const arrows = exampleArrows(row);
  const squareStyles: Record<string, CSSProperties> = arrows.length ? { [row.playedUci.slice(2, 4)]: { background: PLAYED_SQUARE } } : {};
  const boardLabel =
    `${toMoveText(row.fenBefore)}. ` +
    (arrows.length ? `Red arrow: your move in this game, ${row.playedSan}.` : `The position before your move ${row.slipMoveNo}.`);
  const helpId = `rc-ex-help-${index}`;

  const tryIt = async () => {
    setTried('sending');
    setTried(await draftTry(app, row));
  };
  const open = async () => {
    if (!row.gameUrl) return;
    setLink((await openGame(app, row.gameUrl)) === 'opened' ? 'idle' : 'failed');
  };

  return (
    <li className="rc-ex">
      <div className="rc-exTop">
        <MiniBoard id={`rc-ex-${index}`} fen={row.fenBefore} orientation={row.myColor} arrows={arrows} squareStyles={squareStyles} label={boardLabel} />
        <div className="rc-exInfo">
          <div className="rc-exMeta">
            <span>{dateText(row.date)}</span>
            <span aria-hidden="true">·</span>
            <span>vs {row.opponentRating ?? 'unrated'}</span>
            <span className={`rc-chip rc-chip--${row.result}`}>{RESULT[row.result]}</span>
          </div>
          <div className="rc-exMove">
            {/* slipText, with "(quick check)" kept on one line and set softer. */}
            {slipText(row).replace(QUICK, '')}
            <span className="rc-exQuick">{QUICK}</span>
          </div>
          <Sparkline timeline={row.timeline} slipIndex={row.slipIndex} moveNo={row.slipMoveNo} />
        </div>
      </div>
      {slow && <p className="rc-exSlow">{SLOW_SLIP}</p>}
      {(!slow || row.gameUrl) && (
        <div className="rc-exActions">
          {!slow && (
            <button type="button" className="rc-exTry" onClick={() => void tryIt()} disabled={tried === 'sending'} aria-describedby={helpId}>
              Try this position
            </button>
          )}
          {row.gameUrl && (
            <button type="button" className="rc-exLink" onClick={() => void open()}>
              Open on Chess.com <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      )}
      {!slow && (
        <p className="rc-exHelp" id={helpId} aria-live="polite">
          {tried === 'drafted' ? (
            "It's in your message box. Press Enter to start."
          ) : tried === 'failed' ? (
            <>
              Type this in the chat: <span className="rc-exType">{tryText(row)}</span>
            </>
          ) : (
            'Puts it in your message box, ready to send.'
          )}
        </p>
      )}
      {link === 'failed' && row.gameUrl && (
        <p className="rc-exHelp" aria-live="polite">
          Couldn't open the link. Paste this into your browser: <span className="rc-exType">{row.gameUrl}</span>
        </p>
      )}
    </li>
  );
}

/**
 * The examples panel, drawn from its state: a back button (only inside the report card), the
 * page's own title, "Showing 1–10 of 142", the rows and "More". Loading and errors are plain
 * words with a "Try again"; an error never takes the card down.
 */
export function ExamplesPanelView({
  app,
  state,
  fallbackTitle = 'Examples from your games',
  onBack,
  onMore,
  onRetry,
  headingRef,
}: {
  app: RowApp;
  state: ExamplesState;
  /** The heading until the page arrives with its own title (the clicked part's name). */
  fallbackTitle?: string;
  onBack?: () => void;
  /** Undefined when the panel can't ask for more (a page from the model without its query). */
  onMore?: () => void;
  onRetry: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const title = state.phase === 'ready' ? state.title : fallbackTitle;
  return (
    <section className="rc-exPanel" aria-label={title}>
      {onBack && (
        <button type="button" className="rc-back" onClick={onBack}>
          <span aria-hidden="true">←</span> Back to report
        </button>
      )}
      <h2 className="rc-exTitle" tabIndex={-1} ref={headingRef}>
        {title}
      </h2>
      {state.phase === 'loading' && (
        <p className="rc-exNote" role="status">
          <span className="rc-pulse" aria-hidden="true" /> Loading the games…
        </p>
      )}
      {state.phase === 'failed' && (
        <div className="rc-exError" role="alert">
          <p>{state.message}</p>
          <button type="button" className="rc-retry" onClick={onRetry}>
            Try again
          </button>
          <p className="rc-exNote">Or ask the coach in the chat.</p>
        </div>
      )}
      {state.phase === 'ready' && (
        <>
          <p className="rc-exCount" aria-live="polite">
            {showingText(state)}
          </p>
          {state.rows.length > 0 && (
            <p className="rc-secNote">Newest first. Your winning chances before → after the move, from a quick check (rough).</p>
          )}
          <ol className="rc-exList">
            {state.rows.map((r, i) => (
              <ExampleCard key={state.start + i} app={app} row={r} index={state.start + i} source={state.source} />
            ))}
          </ol>
          {hasMore(state) && onMore && (
            <button type="button" className="rc-more" onClick={onMore} disabled={state.more === 'loading'}>
              {state.more === 'loading' ? 'Loading…' : 'More'}
            </button>
          )}
          {state.more === 'failed' && <p className="rc-exNote rc-exNote--center">Couldn't load more games. Press More to try again.</p>}
          {hasMore(state) && !onMore && <p className="rc-exNote rc-exNote--center">Ask the coach in the chat for more of these games.</p>}
        </>
      )}
    </section>
  );
}

/**
 * The live panel: loads the first page through coach_examples (unless it was given one), "More"
 * appends the next. Inside the report card it gets a back button and takes the focus to its
 * heading, so keyboard and screen-reader users land on it.
 */
export function ExamplesPanel({
  app,
  drill,
  query,
  initial,
  onBack,
  fallbackTitle,
}: {
  app: Pick<App, 'callServerTool'> & RowApp;
  drill: DrillRef;
  query: ExamplesQuery | undefined;
  initial?: ExamplesView;
  onBack?: () => void;
  fallbackTitle?: string;
}) {
  const [loader] = useState(() => new ExamplesLoader(app, drill, query, initial));
  const state = useSyncExternalStore(loader.subscribe, loader.getState, loader.getState);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!initial) void loader.load();
    return () => loader.close();
  }, [loader, initial]);
  useEffect(() => {
    if (!onBack || !heading.current) return;
    heading.current.focus({ preventScroll: true });
    return reveal(heading.current);
    // Only when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <ExamplesPanelView
      app={app}
      state={state}
      fallbackTitle={fallbackTitle}
      onBack={onBack}
      onMore={loader.canMore ? () => void loader.more() : undefined}
      onRetry={() => void loader.load()}
      headingRef={heading}
    />
  );
}

/** A page the model asked for (coach_examples called by the coach): the same panel on its own card, no back button. */
export function ExamplesCard({ app, view, query }: { app: App; view: ExamplesView; query: ExamplesQuery | undefined }) {
  return (
    <article className="rc rc--examples">
      <div className="rc-topline">
        <span className="rc-eyebrow">Postgame Coach</span>
      </div>
      <ExamplesPanel app={app} drill={{ source: view.source, key: view.key }} query={query} initial={view} />
    </article>
  );
}
