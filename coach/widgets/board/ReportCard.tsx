import type { CoachView, ReportLabel, ReportRow } from '../../src/server/views';

type ReportView = Extract<CoachView, { kind: 'report' }>;

const MARKS: Record<ReportLabel, { mark: string; verdict: string }> = {
  gap: { mark: '✗', verdict: 'Weak spot' },
  notYourProblem: { mark: '✓', verdict: 'Not a weak spot' },
  noClearDifference: { mark: '–', verdict: 'Too close to call' },
  notEnoughData: { mark: '?', verdict: 'Not enough games yet' },
};

const pct = (x: number) => `${x}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One shared scale for every bar, so rows compare at a glance: a round number above the largest value. */
function scaleMax(rows: ReportRow[]): number {
  const values = rows.flatMap((r) => [r.you, r.them, r.range?.[1]]).filter((v): v is number => v != null);
  const top = Math.max(1, ...values);
  const step = top <= 10 ? 2 : 5;
  return Math.ceil((top * 1.1) / step) * step;
}

function Bar({ row, max }: { row: ReportRow; max: number }) {
  if (row.you === null || row.them === null) {
    return <span className="pg-nodata">Too few games to tell</span>;
  }
  const at = (x: number) => `${Math.min(100, Math.max(0, (x / max) * 100))}%`;
  const [lo, hi] = row.range ?? [row.you, row.you];
  const label =
    `You ${pct(row.you)}, players at your rating ${pct(row.them)}` +
    (row.range ? `, your likely range ${pct(lo)} to ${pct(hi)}` : '');
  return (
    <>
      <div className="pg-track" role="img" aria-label={label}>
        {row.range && <div className="pg-band" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />}
        <div className="pg-them" style={{ left: at(row.them) }} />
        <div className="pg-you" style={{ left: at(row.you) }} />
      </div>
      <div className="pg-nums" aria-hidden="true">
        you {pct(row.you)} · others {pct(row.them)}
      </div>
    </>
  );
}

/**
 * The report card: at most six rows in plain words (✗ ✓ – ?), each with a bar of the player's
 * serious-mistake rate against players at their rating, the likely range as a band, and the
 * game count. Then the coach's headline and this week's focus.
 */
export function ReportCard({ view }: { view: ReportView }) {
  const max = scaleMax(view.rows);
  return (
    <div className="pg-report">
      <h2>Your report card</h2>
      <p className="pg-sub">
        {capitalize(view.timeClass)} · {plural(view.games, 'game')}
      </p>
      <p className="pg-p pg-muted">How often your moves are serious mistakes, next to players at your rating. Lower is better.</p>
      <div className="pg-legend" aria-hidden="true">
        <span>
          <i className="pg-key-you" /> You
        </span>
        <span>
          <i className="pg-key-them" /> Players at your rating
        </span>
        <span>
          <i className="pg-key-band" /> Where you likely are
        </span>
      </div>
      <ul className="pg-rows">
        {view.rows.map((row, i) => (
          <li key={i} className={`pg-row pg-row--${row.label}`}>
            <span className="pg-mark" role="img" aria-label={MARKS[row.label].verdict}>
              {MARKS[row.label].mark}
            </span>
            <div className="pg-name">
              <strong>{row.area}</strong>
              <span className="pg-verdict">{MARKS[row.label].verdict}</span>
            </div>
            <div className="pg-barcell">
              <Bar row={row} max={max} />
            </div>
            <div className="pg-games">{plural(row.games, 'game')}</div>
          </li>
        ))}
      </ul>
      {view.headline && <p className="pg-headline">{view.headline}</p>}
      <p className="pg-focus">
        <strong>This week:</strong> {view.focus ?? 'no single focus yet.'}
      </p>
    </div>
  );
}
