import type { StatusView } from '../../src/server/views';
import './report.css';

/**
 * A calm waiting card while the coach works, in the report card's look (dark by default, light
 * for light hosts). With progress that can be counted, it shows a bar with "312 of 900" and the
 * percentage. Without (or with a total of 0), a softly breathing dot stands in for the bar.
 */
export function StatusCard({ view }: { view: StatusView }) {
  const p = view.progress && view.progress.total > 0 ? view.progress : null;
  const share = p ? Math.min(1, p.done / p.total) : 0;
  return (
    <article className="rc rc--status" role="status" aria-live="polite">
      <div className="rc-sheen" aria-hidden="true" />
      <div className="rc-topline">
        <span className="rc-eyebrow">Postgame Coach</span>
      </div>
      <div className="rc-statusHead">
        {!p && <span className="rc-pulse" aria-hidden="true" />}
        <h2 className="rc-statusTitle">{view.title}</h2>
      </div>
      {view.message && <p className="rc-statusMsg">{view.message}</p>}
      {p && (
        <div className="rc-statusProgress">
          <div
            className="rc-statusBar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={p.total}
            aria-valuenow={p.done}
            aria-label={view.title}
          >
            <div className="rc-statusFill" style={{ width: `${share * 100}%` }} />
          </div>
          <div className="rc-statusNums">
            <span>
              <b>{p.done}</b> of {p.total}
            </span>
            <span>{Math.floor(share * 100)}%</span>
          </div>
        </div>
      )}
    </article>
  );
}
