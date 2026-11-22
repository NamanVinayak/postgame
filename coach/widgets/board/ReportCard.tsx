import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useState, type CSSProperties } from 'react';
import { Chessboard, defaultArrowOptions } from 'react-chessboard';
import { DEFAULT_REPORT_CTA, type ReportPosition, type ReportRow, type ReportView } from '../../src/server/views';
import { Chip, Radar, pct } from './Radar';
import { arrowFor, type Arrow } from './shared';
import './report.css';

type DisplayMode = NonNullable<McpUiHostContext['displayMode']>;

/** What the host said about display modes: the current one and the ones it offers. */
export interface Display {
  mode: DisplayMode | undefined;
  available: DisplayMode[];
}

const WRONG_ARROW = 'rgba(244, 63, 94, 0.92)';
const BEST_ARROW = 'rgba(34, 197, 94, 0.95)';
const WRONG_SQUARE = 'radial-gradient(circle, rgba(244, 63, 94, 0.55) 0 58%, rgba(244, 63, 94, 0.3) 60%)';
const BEST_SQUARE = 'radial-gradient(circle, rgba(34, 197, 94, 0.55) 0 58%, rgba(34, 197, 94, 0.3) 60%)';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Your rating is honest. Your points leak…" → the first sentence plain, the rest in the accent colour. */
function splitHeadline(text: string): [string, string] {
  const m = /^(.+?[.!?])\s+(\S.*)$/s.exec(text.trim());
  return m ? [m[1], m[2]] : [text, ''];
}

/** The win chance lost each time, in words: "about −14% win chance each time". */
function lossText(lossPts: number): string {
  const n = Math.round(lossPts);
  return n < 1 ? 'under 1% win chance each time' : `about −${n}% win chance each time`;
}

// Small boards need thicker arrows to read.
const MINI_ARROWS = { ...defaultArrowOptions, arrowWidthDenominator: 4 };

/**
 * A small, still board: the usual wrong move in red, the best move in green. The red arrow is
 * drawn last so it stays visible where it crosses the green one (a knight's L can run over a
 * short pawn move), and each move's target square is tinted in its colour.
 */
function MiniBoard({ p, id }: { p: ReportPosition; id: string }) {
  const arrows = [arrowFor(p.bestUci, BEST_ARROW), arrowFor(p.wrongUci, WRONG_ARROW)].filter((a): a is Arrow => a !== null);
  const squareStyles: Record<string, CSSProperties> = { [p.bestUci.slice(2, 4)]: { background: BEST_SQUARE } };
  if (p.wrongUci) squareStyles[p.wrongUci.slice(2, 4)] = { background: WRONG_SQUARE };
  const toMove = p.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  return (
    <div
      className="rc-mini"
      role="img"
      aria-label={`${toMove} to move. Red arrow: ${p.wrongSan[0]}. Green arrow: ${p.bestSan}.`}
    >
      <Chessboard
        options={{
          id,
          position: p.fen,
          boardOrientation: p.orientation,
          arrows,
          arrowOptions: MINI_ARROWS,
          squareStyles,
          allowDragging: false,
          allowDrawingArrows: false,
          showNotation: false,
          showAnimations: false,
          darkSquareStyle: { backgroundColor: 'var(--rc-sq-dark)' },
          lightSquareStyle: { backgroundColor: 'var(--rc-sq-light)' },
        }}
      />
    </div>
  );
}

function Mission({ p, index }: { p: ReportPosition; index: number }) {
  const toMove = p.fen.split(' ')[1] === 'w' ? 'White to move' : 'Black to move';
  const share = p.drillsTotal > 0 ? Math.min(1, p.drillsDone / p.drillsTotal) : 0;
  return (
    <article className="rc-mission">
      <MiniBoard p={p} id={`rc-mission-${index}`} />
      <div className="rc-mText">
        <div className="rc-mKicker">Mission {index + 1}</div>
        <div className="rc-mTitle">
          Fix: play <span className="rc-best">{p.bestSan}</span> here
        </div>
        <div className="rc-mMeta">{p.opening ? `${p.opening} · ${toMove}` : toMove}</div>
        <div className="rc-mMeta">
          You usually played{' '}
          {p.wrongSan.map((san, i) => (
            <span key={i}>
              {i > 0 && (i === p.wrongSan.length - 1 ? ' or ' : ', ')}
              <s className="rc-wrong">{san}</s>
            </span>
          ))}
          <span className="rc-sep"> · </span>
          <span className="rc-mCount">
            wrong in {p.wrongTimes} of {plural(p.seenTimes, 'game')}
          </span>
        </div>
        <div className="rc-mLoss">{lossText(p.lossPts)}</div>
        <div className="rc-progress">
          <div
            className="rc-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={p.drillsTotal}
            aria-valuenow={p.drillsDone}
            aria-label="Drills done"
          >
            <div className="rc-fill" style={{ width: `${share * 100}%` }} />
          </div>
          <span>
            {p.drillsDone} / {plural(p.drillsTotal, 'drill')}
          </span>
        </div>
      </div>
    </article>
  );
}

/**
 * The areas as a list: instead of the chart when there are fewer than three areas (a radar
 * has no shape then), and under the chart in narrow frames, where the chart shows names only.
 */
function AreaList({ rows, narrowOnly = false }: { rows: ReportRow[]; narrowOnly?: boolean }) {
  return (
    <ul className={narrowOnly ? 'rc-areaList rc-areaList--narrow' : 'rc-areaList'}>
      {rows.map((row, i) => (
        <li key={i} className={row.you === null ? 'rc-axis--faint' : undefined}>
          <span className="rc-axisName">{row.area}</span>
          <span className="rc-axisNums">
            {row.you !== null && row.them !== null ? (
              <>
                <b>{pct(row.you)}</b> <span>vs {pct(row.them)}</span>
              </>
            ) : (
              <span>{plural(row.games, 'game')}</span>
            )}
          </span>
          <Chip label={row.label} />
        </li>
      ))}
    </ul>
  );
}

type Sent = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * The report card, a "scouting report": six areas on a hexagon (you against players at your
 * rating), the coach's verdict, this week's missions (the positions the player keeps getting
 * wrong) and a button that puts "Start this week's training" in the chat box.
 *
 * Inline it is one compact column; "Expand" asks the host for fullscreen (shown only when the
 * host offers it), where the chart and the verdict sit side by side.
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
  const full = display.mode === 'fullscreen';
  const canExpand = !full && display.available.includes('fullscreen');
  const canCollapse = full && display.available.includes('inline');
  const cta = view.cta ?? DEFAULT_REPORT_CTA;
  const positions = view.positions ?? [];
  const done = positions.filter((p) => p.drillsTotal > 0 && p.drillsDone >= p.drillsTotal).length;
  const [lead, rest] = splitHeadline(view.headline);
  const chart = view.rows.length >= 3; // a radar needs at least three spokes

  const switchTo = async (mode: DisplayMode) => {
    try {
      const res = await app.requestDisplayMode({ mode });
      onDisplayMode(res.mode);
    } catch {
      // The host said no; stay as we are.
    }
  };

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
    <article className="rc" data-mode={full ? 'fullscreen' : 'inline'}>
      <div className="rc-sheen" aria-hidden="true" />
      <header className="rc-head">
        <div className="rc-topline">
          <span className="rc-eyebrow">Postgame Coach · Scouting report</span>
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
        <div className="rc-titleRow">
          <h2 className="rc-title">Your chess, measured</h2>
          <div className="rc-meta">
            <div className="rc-metaBig">{view.games}</div>
            <div className="rc-metaSmall">
              {capitalize(view.timeClass)} game{view.games === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      </header>

      <div className="rc-body">
        <section className="rc-left" aria-label="Six areas, next to players at your rating">
          {chart ? (
            <>
              <Radar rows={view.rows} size={full ? 'large' : 'compact'} />
              <AreaList rows={view.rows} narrowOnly />
            </>
          ) : (
            <AreaList rows={view.rows} />
          )}
          <div className="rc-legend">
            {chart && (
              <>
                <div className="rc-keys" aria-hidden="true">
                  <span>
                    <i className="rc-kYou" /> You
                  </span>
                  <span>
                    <i className="rc-kPeer" /> Players at your rating
                  </span>
                  <span>
                    <i className="rc-kRange" /> Where you likely are
                  </span>
                </div>
                <div className="rc-legendStrong">
                  Dashed hexagon = players at your rating. Outside it = fewer serious mistakes than them; inside = more.
                </div>
              </>
            )}
            <div className="rc-legendNote">
              Numbers: how often a move was a serious mistake, yours vs theirs.
              {chart && <> The chart's edge means half their rate.</>}
            </div>
          </div>
        </section>

        <section className="rc-right">
          <div className="rc-verdict">
            <div className="rc-kicker">Verdict</div>
            <p className="rc-verdictText">
              {lead}
              {rest && (
                <>
                  {' '}
                  <em>{rest}</em>
                </>
              )}
            </p>
            {view.subhead && <p className="rc-sub">{view.subhead}</p>}
          </div>

          {positions.length > 0 ? (
            <section className="rc-missions" aria-label="This week's missions">
              <div className="rc-secHead">
                <h3>This week's missions</h3>
                <span className="rc-count">
                  {done} of {positions.length} done
                </span>
              </div>
              <div className="rc-missionList">
                {positions.map((p, i) => (
                  <Mission key={i} p={p} index={i} />
                ))}
              </div>
            </section>
          ) : (
            <p className="rc-focus">
              <strong>This week:</strong> {view.focus ?? 'no single focus yet.'}
            </p>
          )}

          <button type="button" className="rc-cta" onClick={() => void start()} disabled={sent === 'sending'}>
            <span>{cta}</span>
            <span aria-hidden="true">→</span>
          </button>
          {sent === 'sent' && <p className="rc-status">It's in your chat box. Press Enter to start.</p>}
          {sent === 'failed' && <p className="rc-status">Type “{cta}” in the chat to begin.</p>}
        </section>
      </div>
    </article>
  );
}
