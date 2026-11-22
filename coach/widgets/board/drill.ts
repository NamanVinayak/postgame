import type { App } from '@modelcontextprotocol/ext-apps';
import type { ExampleSource } from '../../src/diagnosis/examples';
import {
  MAX_EXAMPLES_PER_PAGE,
  parseCoachView,
  type ExampleRowView,
  type ExamplesView,
  type ReportView,
} from '../../src/server/views';
import { arrowFor, type Arrow } from './shared';

/**
 * The drill-down behind the report card (plan Task P6): which finding opens which examples, the
 * coach_examples calls (first page, then "More"), and the two row actions. Plain logic with no
 * DOM, so the tests drive it with a stand-in App; ExamplesPanel only draws its state.
 */

/** What one click opens: a coach_examples source, and for a quick fix its position key. */
export interface DrillRef {
  source: ExampleSource;
  key?: string;
}

/** What each clickable part of the card opens; null where the payload has no ref (it stays still). */
export interface DrillTargets {
  hero: DrillRef | null;
  bars: (DrillRef | null)[];
  fixes: (DrillRef | null)[];
}

export function drillTargets(view: ReportView): DrillTargets {
  return {
    hero: view.hero.source ? { source: view.hero.source } : null,
    bars: view.leaks.map((l) => (l.key ? { source: l.key } : null)),
    fixes: (view.quickFixes ?? []).map((q) => (q.key ? { source: 'quickFix', key: q.key } : null)),
  };
}

/** The fields of a coach_examples call that say which games (not which page). */
const QUERY_FIELDS = ['usernames', 'accounts', 'timeClass', 'maxGames', 'asOf'] as const;

/** The games a page is about, passed straight back to coach_examples (the report's `query`, or the call's own). */
export type ExamplesQuery = { [K in (typeof QUERY_FIELDS)[number]]?: unknown };

/**
 * The game fields of the tool call that produced a standalone page (from ontoolinput), so "More"
 * asks about the same games. Undefined when the call's arguments never arrived.
 */
export function pickQuery(args: Record<string, unknown> | undefined): ExamplesQuery | undefined {
  if (!args) return undefined;
  const out: ExamplesQuery = {};
  for (const k of QUERY_FIELDS) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

export function examplesArgs(ref: DrillRef, offset: number, query: ExamplesQuery | undefined): Record<string, unknown> {
  return { source: ref.source, ...(ref.key !== undefined ? { key: ref.key } : {}), offset, limit: MAX_EXAMPLES_PER_PAGE, ...query };
}

export type ExamplesState =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | {
      phase: 'ready';
      title: string;
      source: ExampleSource;
      total: number;
      /** The offset of the first row shown. */
      start: number;
      rows: ExampleRowView[];
      more: 'idle' | 'loading' | 'failed';
    };
type Ready = Extract<ExamplesState, { phase: 'ready' }>;

type ToolCaller = Pick<App, 'callServerTool'>;

const MSG = {
  unreachable: "Couldn't reach the coach to load these games.",
  refused: "Couldn't load these games.",
  unreadable: "Couldn't read the games the coach sent.",
};

/** One coach_examples call, read in plain words: the page, or why there isn't one. */
async function fetchPage(app: ToolCaller, ref: DrillRef, offset: number, query: ExamplesQuery | undefined) {
  let res: Awaited<ReturnType<ToolCaller['callServerTool']>>;
  try {
    res = await app.callServerTool({ name: 'coach_examples', arguments: examplesArgs(ref, offset, query) });
  } catch {
    return { error: MSG.unreachable };
  }
  if (!res || res.isError) return { error: MSG.refused };
  const view = parseCoachView(res.structuredContent);
  // Still analysing: the server says so in a status view.
  if (view?.kind === 'status') return { error: view.message || view.title };
  if (view?.kind !== 'examples' || view.source !== ref.source || (ref.key !== undefined && view.key !== ref.key)) {
    return { error: MSG.unreadable };
  }
  return { page: view };
}

/**
 * The examples panel's state: the first page, then "More" (the next offset, appended). A reply
 * that lands after the panel closed, or after a newer request, is ignored. With `initial` (a page
 * the model asked for), it starts ready; "More" needs the query those games came from.
 */
export class ExamplesLoader {
  private state: ExamplesState;
  private listeners = new Set<() => void>();
  private seq = 0;
  private closed = false;
  readonly canMore: boolean;

  constructor(
    private app: ToolCaller,
    private ref: DrillRef,
    private query: ExamplesQuery | undefined,
    initial?: ExamplesView,
  ) {
    this.state = initial ? fromPage(initial) : { phase: 'loading' };
    // A drill from the card always knows its games; a standalone page only with its call's arguments.
    this.canMore = initial === undefined || query !== undefined;
  }

  getState = (): ExamplesState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(next: ExamplesState) {
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  /** The first page (again, after a failure). */
  async load(): Promise<void> {
    const id = ++this.seq;
    this.set({ phase: 'loading' });
    const r = await fetchPage(this.app, this.ref, 0, this.query);
    if (this.closed || id !== this.seq) return;
    this.set('page' in r && r.page ? fromPage(r.page) : { phase: 'failed', message: r.error ?? MSG.unreadable });
  }

  /** The next page, appended; on failure the rows stay and the panel says so. */
  async more(): Promise<void> {
    const s = this.state;
    if (s.phase !== 'ready' || s.more === 'loading' || !hasMore(s) || !this.canMore) return;
    const id = ++this.seq;
    this.set({ ...s, more: 'loading' });
    const r = await fetchPage(this.app, this.ref, s.start + s.rows.length, this.query);
    if (this.closed || id !== this.seq) return;
    const now = this.state as Ready;
    if ('page' in r && r.page) {
      this.set({ ...now, title: r.page.title, total: r.page.total, rows: [...now.rows, ...r.page.examples], more: 'idle' });
    } else {
      this.set({ ...now, more: 'failed' });
    }
  }

  close() {
    this.closed = true;
    this.listeners.clear();
  }
}

function fromPage(p: ExamplesView): Ready {
  return { phase: 'ready', title: p.title, source: p.source, total: p.total, start: p.offset, rows: p.examples, more: 'idle' };
}

export const hasMore = (s: Ready) => s.start + s.rows.length < s.total;

/** "Showing 1–10 of 142" (or "Showing 1 of 1"). */
export function showingText(s: Ready): string {
  if (s.rows.length === 0) return s.total === 0 ? 'No games to show.' : `No more games (${s.total} in all).`;
  const first = s.start + 1;
  const last = s.start + s.rows.length;
  return first === last ? `Showing ${first} of ${s.total}` : `Showing ${first}–${last} of ${s.total}`;
}

/** "Move 23: 82% → 30% (quick check)": the player's win % before and after, whole numbers. */
export const slipText = (r: ExampleRowView) =>
  `Move ${r.slipMoveNo}: ${Math.round(r.quickWinBefore)}% → ${Math.round(r.quickWinAfter)}% (quick check)`;

/** What "Try this position" puts in the chat; the coach then asks it with coach_ask_position. */
export const tryText = (r: ExampleRowView) => `Coach me on this position: game ${r.gameId}, ply ${r.slipPly}`;

/** A costly move: the player's winning chances dropped by 10 points or more (the card's definition). */
export const COSTLY_DROP = 10;
export const isCostly = (r: ExampleRowView) => r.quickWinBefore - r.quickWinAfter >= COSTLY_DROP;

/** A thrown win with no single costly move (for example lost on time while still winning). */
export const isSlowSlip = (source: ExampleSource, r: ExampleRowView) => source === 'thrownWins' && !isCostly(r);

/** The paper look's red, as the played move's arrow. */
export const PLAYED_RED = 'rgba(180, 46, 36, 0.9)';

/**
 * The example board's arrows: the played move in red, and nothing else (no answer, no green). A
 * move that wasn't costly gets no arrow, so a fine move is never drawn as the mistake.
 */
export function exampleArrows(r: ExampleRowView): Arrow[] {
  const a = isCostly(r) ? arrowFor(r.playedUci, PLAYED_RED) : null;
  return a ? [a] : [];
}

type Outcome = 'drafted' | 'failed';

/**
 * "Try this position": drafts the coach request into the chat box (Claude Desktop doesn't send
 * it; the player presses Enter). 'failed' when the host lacks sendMessage, refuses or throws:
 * the row then tells the player what to type.
 */
export async function draftTry(app: Partial<Pick<App, 'sendMessage'>>, r: ExampleRowView): Promise<Outcome> {
  if (typeof app.sendMessage !== 'function') return 'failed';
  try {
    const res = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: tryText(r) }] });
    return res?.isError ? 'failed' : 'drafted';
  } catch {
    return 'failed';
  }
}

/** "Open on Chess.com": asks the host to open the game; 'failed' when it can't or won't. */
export async function openGame(app: Partial<Pick<App, 'openLink'>>, url: string): Promise<'opened' | 'failed'> {
  if (typeof app.openLink !== 'function') return 'failed';
  try {
    const res = await app.openLink({ url });
    return res?.isError ? 'failed' : 'opened';
  } catch {
    return 'failed';
  }
}

/** The sparkline's points in an w×h box with `pad` inside: x by ply order, y by win % (100 at the top). */
export function sparkGeometry(timeline: number[], slipIndex: number, w: number, h: number, pad: number) {
  const n = timeline.length;
  const x = (i: number) => (n <= 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => pad + ((100 - Math.min(100, Math.max(0, v))) / 100) * (h - 2 * pad);
  const at = (i: number) => ({ x: x(i), y: y(timeline[i] ?? 50) });
  const i = Math.min(Math.max(0, slipIndex), Math.max(0, n - 1));
  return {
    points: timeline.map((v, k) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    slip: at(i),
    /** The point before the slip, for the red drop segment (null at the first point). */
    before: i > 0 ? at(i - 1) : null,
    mid: y(50),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-21' as "21 Nov 2026", from its parts (no time zone can shift the day). */
export function dateText(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return MONTHS[m - 1] ? `${d} ${MONTHS[m - 1]} ${y}` : iso;
}
