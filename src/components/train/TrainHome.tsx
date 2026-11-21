import { useEffect, useState } from 'react';
import { getAllProgress, getTrainingDays } from '../../services/storage';
import { buildSession, isLearned, type DrillProgress, type SessionItem } from '../../training/scheduler';
import { progressSummary } from '../../training/summary';
import type { CoachPackState } from '../../training/useCoachPack';
import { TRAIN_COPY, learnedOf, trainedDays } from '../../training/copy';
import { localDay } from '../../training/day';

interface Props {
  coach: CoachPackState;
  onStart: (items: SessionItem[], progress: Map<string, DrillProgress>) => void;
  onBack: () => void;
  now?: () => number;
}

export function TrainHome({ coach, onStart, onBack, now = Date.now }: Props) {
  const [progress, setProgress] = useState<Map<string, DrillProgress> | null>(null);
  const [copied, setCopied] = useState(false);
  const { pack } = coach;

  useEffect(() => {
    let alive = true;
    void getAllProgress().then((p) => alive && setProgress(p));
    return () => {
      alive = false;
    };
  }, [pack]);

  const t = now();
  const items = pack && progress ? buildSession(pack, progress, t) : [];
  const lastWeek = new Set(Array.from({ length: 7 }, (_, i) => localDay(t - i * 86_400_000)));
  const daysTrained = getTrainingDays().filter((d) => lastWeek.has(d)).length;

  const unlink = () => {
    coach.unlink();
    onBack();
  };

  const copy = async () => {
    if (!pack || !progress) return;
    try {
      await navigator.clipboard.writeText(progressSummary(pack, progress, t));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="app-shell train">
      <header className="train-header">
        <button className="link-button" onClick={onBack}>
          ← Games
        </button>
        <h1 className="brand-sm">{TRAIN_COPY.train}</h1>
      </header>

      {coach.message && (
        <p className={coach.status === 'error' ? 'error' : 'status-line'} aria-live="polite">
          {coach.message}
        </p>
      )}

      {pack && (
        <>
          <button
            className="train-start"
            disabled={!progress || items.length === 0}
            onClick={() => progress && onStart(items, progress)}
          >
            <span className="train-start-title">▶ {TRAIN_COPY.todaysDrills}</span>
            <span className="train-start-sub">
              {items.length} due{items.length > 0 ? ' · about 10 minutes' : ''}
            </span>
          </button>
          {progress && items.length === 0 && <p className="empty">{TRAIN_COPY.nothingDue}</p>}

          <ul className="train-openings">
            {pack.openings
              .filter((o) => pack.drills.some((d) => d.opening === o.key && d.status === 'active'))
              .map((o) => {
                const drills = pack.drills.filter((d) => d.opening === o.key && d.status === 'active');
                const learned = drills.filter((d) => {
                  const p = progress?.get(d.id);
                  return p !== undefined && isLearned(p);
                }).length;
                return (
                  <li key={o.key}>
                    <span>
                      {o.name} (you’re {o.side === 'white' ? 'White' : 'Black'})
                    </span>
                    <span className="train-muted">{learnedOf(learned, drills.length)}</span>
                  </li>
                );
              })}
          </ul>

          <p className="train-muted">{trainedDays(daysTrained)}</p>

          <div className="train-tools">
            <button className="link-button" onClick={() => void copy()}>
              {TRAIN_COPY.copyProgress}
            </button>
            {copied && <p className="train-muted">{TRAIN_COPY.copied}</p>}
          </div>
        </>
      )}

      <div className="train-tools">
        <button className="link-button train-unlink" onClick={unlink}>
          {TRAIN_COPY.unlink}
        </button>
      </div>
    </div>
  );
}
