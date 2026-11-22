import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { DEFAULT_REPORT_CTA, type QuickFix, type ReportLeak, type ReportView } from '../../src/server/views';
import { drillTargets, type DrillRef } from './drill';
import { ExamplesPanel } from './ExamplesPanel';
import { MiniBoard, toMoveText } from './MiniBoard';
import { arrowFor, type Arrow } from './shared';
import './report.css';

type DisplayMode = NonNullable<McpUiHostContext['displayMode']>;

/** What the host said about display modes: the current one and the ones it offers. */
export interface Display {
  mode: DisplayMode | undefined;
  available: DisplayMode[];
}

// The paper look's red and green, as board arrows and square tints.
const WRONG_ARROW = 'rgba(180, 46, 36, 0.9)';
const BEST_ARROW = 'rgba(27, 110, 62, 0.92)';
const WRONG_SQUARE = 'radial-gradient(circle, rgba(180, 46, 36, 0.5) 0 58%, rgba(180, 46, 36, 0.28) 60%)';
const BEST_SQUARE = 'radial-gradient(circle, rgba(27, 110, 62, 0.5) 0 58%, rgba(27, 110, 62, 0.28) 60%)';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** What "costly move" means, in one plain line under the bars (a mistake or blunder in the analysis). */
const COSTLY_MOVE = 'Costly move = a move that drops your winning chances by 10% or more (for example from 60% to 48%).';
const orList = (moves: string[]) =>
  moves.map((san, i) => (
    <span key={i}>
      {i > 0 && (i === moves.length - 1 ? ' or ' : ', ')}
      <s className="rc-wrong">{san}</s>
    </span>
  ));

/**
 * The bars' scale: one straight scale from 0 for every bar, up to the next ten above the
 * largest share or range end, so no bar or range is cut and bars compare at a glance.
 */
function barScale(leaks: ReportLeak[]): number {
  const top = Math.max(10, ...leaks.flatMap((l) => [l.sharePct, l.range[1]]));
  return Math.min(100, Math.ceil(top / 10) * 10);
}

/**
 * One ranked bar: the share as a solid bar, the likely range as a soft band around it (only when
 * the ranges can be trusted), and one plain line under it. With `onOpen` (the bar has a drill
 * ref) the whole bar is a button that opens its examples; spans inside, so the button stays
 * valid HTML.
 */
function LeakBar({ leak, max, showRange, index, onOpen }: { leak: ReportLeak; max: number; showRange: boolean; index: number; onOpen?: () => void }) {
  const at = (v: number) => `${(Math.min(max, Math.max(0, v)) / max) * 100}%`;
  const [lo, hi] = leak.range;
  const label =
    `${leak.label}: ${leak.sharePct}% of the winning chances you gave away` +
    (showRange ? ` (likely ${lo} to ${hi}%)` : '') +
    (leak.detail ? `. ${capitalize(leak.detail)}.` : '.');
  const body = (
    <span className="rc-leakBody">
      <span className="rc-leakHead">
        <span className="rc-leakLabel">{leak.label}</span>
        <span className="rc-leakPct">{leak.sharePct}%</span>
      </span>
      <span className="rc-leakTrack" role="img" aria-label={label}>
        {showRange && <span className="rc-leakRange" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />}
        <span className="rc-leakFill" style={{ width: at(leak.sharePct) }} />
      </span>
      {leak.detail && <span className="rc-leakDetail">{capitalize(leak.detail)}</span>}
    </span>
  );
  return (
    <li className="rc-leak">
      {onOpen ? (
        <button type="button" className="rc-leakBtn" data-drill={`bar-${index}`} onClick={onOpen} aria-label={`${label} See examples from your games.`}>
          {body}
          <span className="rc-leakGo" aria-hidden="true">
            ›
          </span>
        </button>
      ) : (
        body
      )}
    </li>
  );
}

function QuickFixCard({ q, index, onOpen }: { q: QuickFix; index: number; onOpen?: () => void }) {
  const shown = q.revealed && q.bestSan !== null && q.bestUci !== null;
  const missing = q.revealed && !shown; // tried, but there is no answer to show
  const arrows = [shown ? arrowFor(q.bestUci, BEST_ARROW) : null, arrowFor(q.wrongUci, WRONG_ARROW)].filter((a): a is Arrow => a !== null);
  const squareStyles: Record<string, CSSProperties> = {};
  if (shown && q.bestUci) squareStyles[q.bestUci.slice(2, 4)] = { background: BEST_SQUARE };
  if (q.wrongUci) squareStyles[q.wrongUci.slice(2, 4)] = { background: WRONG_SQUARE };
  const boardLabel = `${toMoveText(q.fen)}. Red arrow: your usual move ${q.wrongSan[0]}.` + (shown ? ` Green arrow: ${q.bestSan}.` : '');
  return (
    <article className="rc-fix">
      <MiniBoard id={`rc-fix-${index}`} fen={q.fen} orientation={q.orientation} arrows={arrows} squareStyles={squareStyles} label={boardLabel} />
      <div className="rc-fixText">
        <div className="rc-fixLabel">{q.label}</div>
        <div className="rc-fixMeta">
          You usually play {orList(q.wrongSan)} · {q.times}
        </div>
        {shown ? (
          <div className="rc-fixAnswer">
            Fix: play <span className="rc-best">{q.bestSan}</span> here
          </div>
        ) : missing ? (
          <div className="rc-fixHidden">Answer not available</div>
        ) : (
          <div className="rc-fixHidden">
            <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
              <rect x="1" y="5" width="9" height="6.5" rx="1.5" fill="currentColor" />
              <path d="M3 5V3.6a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>{' '}
            Answer after you try it
          </div>
        )}
        {onOpen && (
          <div>
            <button
              type="button"
              className="rc-fixGo"
              data-drill={`fix-${index}`}
              onClick={onOpen}
              aria-label={`See the games that reached this position: ${q.label}`}
            >
              See the games <span aria-hidden="true">→</span>
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

/** The hero's cue: neutral, so it never claims the hero's own number (the clock hero counts losses on time). */
const HERO_CUE = 'See examples from your games';

type Sent = 'idle' | 'sending' | 'sent' | 'failed';

/** The drill-down that's open: what it shows, which button opened it (focus goes back there), its heading while loading. */
interface OpenDrill {
  ref: DrillRef;
  from: string;
  title: string;
}

/**
 * The report card (spec §6c), in a bright "paper" look that stays the same in light and dark
 * hosts: a kicker line with the game count, the hero sentence in a big serif, ranked bars of
 * where the lost winning chances go (each with a soft likely range when the ranges can be
 * trusted, and one plain line in costly moves), one muted context line, this week's lesson (its
 * boards carry no answers), quick fixes whose answers stay hidden until revealed, and a button
 * that puts "Start this week's training" in the chat box.
 *
 * Inline it is one column; "Expand" asks the host for fullscreen (shown only when the host
 * offers it), where the bars sit on the left and the lesson on the right. Parts with nothing in
 * them (no bars, no boards, no drills) are left out rather than shown empty.
 *
 * Drill-down (plan Task P6): the hero, each bar and each quick fix that carries a ref is a button.
 * It swaps the card's body for the examples panel (coach_examples with the card's query); "Back to
 * report" brings the card back and returns the focus to the button. Without refs (an older
 * payload) nothing is clickable.
 */
export function ReportCard({
  app,
  view,
  display,
  onDisplayMode,
}: {
  app: App;
  view: ReportView;
  display: Display;
  onDisplayMode: (mode: DisplayMode) => void;
}) {
  const [sent, setSent] = useState<Sent>('idle');
  const [drill, setDrill] = useState<OpenDrill | null>(null);
  const card = useRef<HTMLElement>(null);
  const returnTo = useRef<string | null>(null);
  const targets = drillTargets(view);
  const full = display.mode === 'fullscreen';
  const canExpand = !full && display.available.includes('fullscreen');
  const canCollapse = full && display.available.includes('inline');
  const cta = view.cta ?? DEFAULT_REPORT_CTA;
  const focus = view.focus;
  const fixes = view.quickFixes ?? [];
  const prompts = [...new Set(focus.positions.map((p) => p.prompt))];
  const onePrompt = prompts.length === 1 ? prompts[0] : null;
  const max = barScale(view.leaks);
  const share = focus.drillsTotal > 0 ? Math.min(1, focus.drillsDone / focus.drillsTotal) : 0;
  const showRange = view.rangesReliable !== false;

  const switchTo = async (mode: DisplayMode) => {
    try {
      const res = await app.requestDisplayMode({ mode });
      onDisplayMode(res.mode);
    } catch {
      // The host said no; stay as we are.
    }
  };

  const openDrill = (ref: DrillRef | null, from: string, title: string) =>
    ref
      ? () => {
          returnTo.current = from;
          setDrill({ ref, from, title });
        }
      : undefined;

  // Back from the panel: the focus returns to the button that opened it.
  useEffect(() => {
    if (drill || !returnTo.current) return;
    card.current?.querySelector<HTMLElement>(`[data-drill="${returnTo.current}"]`)?.focus();
    returnTo.current = null;
  }, [drill]);

  const openHero = openDrill(targets.hero, 'hero', 'Examples from your games');
  const anyBar = targets.bars.some((t) => t !== null);
  const anyFix = targets.fixes.some((t) => t !== null);

  const start = async () => {
    setSent('sending');
    try {
      const res = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: cta }] });
      setSent(res.isError ? 'failed' : 'sent');
    } catch {
      setSent('failed');
    }
  };

  return (
    <article className="rc" data-mode={full ? 'fullscreen' : 'inline'} ref={card}>
      <header className="rc-head">
        <div className="rc-topline">
          <span className="rc-eyebrow">Postgame Coach</span>
          <span className="rc-meta">
            {capitalize(view.timeClass)} · {view.games} game{view.games === 1 ? '' : 's'}
          </span>
          {canExpand && (
            <button type="button" className="rc-ghost" onClick={() => void switchTo('fullscreen')}>
              <span aria-hidden="true">⤢</span> Expand
            </button>
          )}
          {canCollapse && (
            <button type="button" className="rc-ghost" onClick={() => void switchTo('inline')}>
              <span aria-hidden="true">✕</span> Close
            </button>
          )}
        </div>
        {!drill && (
          <h2 className="rc-hero">
            {openHero ? (
              <button type="button" className="rc-heroBtn" data-drill="hero" onClick={openHero}>
                <span className="rc-heroLine">{view.hero.headline}</span>
                {view.hero.sub && <em className="rc-heroSub">{view.hero.sub}</em>}
                <span className="rc-seeMore">
                  {HERO_CUE} <span aria-hidden="true">→</span>
                </span>
              </button>
            ) : (
              <>
                <span className="rc-heroLine">{view.hero.headline}</span>
                {view.hero.sub && <em className="rc-heroSub">{view.hero.sub}</em>}
              </>
            )}
          </h2>
        )}
      </header>

      {drill ? (
        <ExamplesPanel key={drill.from} app={app} drill={drill.ref} query={view.query} onBack={() => setDrill(null)} fallbackTitle={drill.title} />
      ) : (
        <div className="rc-body">
          {(view.leaks.length > 0 || view.context) && (
            <section className="rc-left">
              {view.leaks.length > 0 && (
                <section className="rc-leaks" aria-label="Where your lost winning chances go">
                  <h3 className="rc-secTitle">Where your lost winning chances go</h3>
                  <p className="rc-secNote">
                    Share of all the winning chances you gave away
                    {showRange && (
                      <>
                        {' · '}
                        <i className="rc-kRange" aria-hidden="true" /> likely range
                      </>
                    )}
                  </p>
                  {anyBar && <p className="rc-secNote">Tap a bar to see examples from your games.</p>}
                  <ol className="rc-leakList">
                    {view.leaks.map((l, i) => (
                      <LeakBar key={i} index={i} leak={l} max={max} showRange={showRange} onOpen={openDrill(targets.bars[i], `bar-${i}`, l.label)} />
                    ))}
                  </ol>
                  <p className="rc-costly">{COSTLY_MOVE}</p>
                  {!showRange && <p className="rc-costly">Too few games to show how sure these numbers are.</p>}
                </section>
              )}
              {view.context && <p className="rc-context">{view.context}</p>}
            </section>
          )}

          <section className="rc-right">
            <section className="rc-focus" aria-label={`This week: ${focus.title}`}>
              <div className="rc-kicker">This week</div>
              <h3 className="rc-focusTitle">{focus.title}</h3>
              {focus.line && <p className="rc-focusLine">{focus.line}</p>}
              {focus.estimate && <p className="rc-estimate">{focus.estimate}</p>}
              {focus.positions.length > 0 && (
                <>
                  {onePrompt && <p className="rc-prompt">{onePrompt}</p>}
                  <div className="rc-boards">
                    {focus.positions.map((p, i) => (
                      <figure key={i} className="rc-boardFig">
                        <MiniBoard id={`rc-focus-${i}`} fen={p.fen} orientation={p.orientation} label={`${toMoveText(p.fen)}. ${p.prompt}`} />
                        <figcaption>{onePrompt ? toMoveText(p.fen) : `${toMoveText(p.fen)}. ${p.prompt}`}</figcaption>
                      </figure>
                    ))}
                  </div>
                </>
              )}
              {focus.drillsTotal > 0 && (
                <div className="rc-progress">
                  <div
                    className="rc-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={focus.drillsTotal}
                    aria-valuenow={focus.drillsDone}
                    aria-label="Drills done this week"
                  >
                    <div className="rc-fill" style={{ width: `${share * 100}%` }} />
                  </div>
                  <span>
                    {focus.drillsDone} / {focus.drillsTotal}
                  </span>
                </div>
              )}
            </section>

            {fixes.length > 0 && (
              <section className="rc-fixes" aria-label="Quick fixes">
                <h3 className="rc-secTitle">Quick fixes</h3>
                <p className="rc-secNote">Positions you keep reaching{anyFix ? ' · tap one to see the games' : ''}</p>
                <div className="rc-fixList">
                  {fixes.map((q, i) => (
                    <QuickFixCard key={i} q={q} index={i} onOpen={openDrill(targets.fixes[i] ?? null, `fix-${i}`, q.label)} />
                  ))}
                </div>
              </section>
            )}

            <button type="button" className="rc-cta" onClick={() => void start()} disabled={sent === 'sending'}>
              <span>{cta}</span>
              <span aria-hidden="true">→</span>
            </button>
            {sent === 'sent' && <p className="rc-status">It's in your chat box. Press Enter to start.</p>}
            {sent === 'failed' && <p className="rc-status">Type “{cta}” in the chat to begin.</p>}
          </section>
        </div>
      )}
    </article>
  );
}
