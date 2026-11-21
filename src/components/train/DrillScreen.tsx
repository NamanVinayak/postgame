import { useCallback, useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { TrainBoard, type BoardArrow } from './TrainBoard';
import { markTrainedToday, saveProgress } from '../../services/storage';
import { applyAnswer, type DrillProgress, type Outcome, type SessionItem } from '../../training/scheduler';
import { afterAnswer, type SessionState } from '../../training/session';
import { judge, tryMove, type Verdict } from '../../training/moveCheck';
import { positionFen, sideToMove } from '../../training/pack';
import { TRAIN_COPY, fixedInRealGames, playedTimes } from '../../training/copy';

interface Props {
  items: SessionItem[];
  progress: Map<string, DrillProgress>;
  onDone: (answered: number) => void;
  /** Pause between moves when replaying a line. */
  stepDelayMs?: number;
  now?: () => number;
}

type Phase = 'intro' | 'ask' | 'right' | 'punish' | 'show' | 'fixed';

/** from/to squares of a SAN move in a position. */
function squaresOf(fen: string, san: string): { from: string; to: string; fen: string } {
  const chess = new Chess(fen);
  const m = chess.move(san);
  return { from: m.from, to: m.to, fen: chess.fen() };
}

export function DrillScreen({ items, progress, onDone, stepDelayMs = 700, now = Date.now }: Props) {
  const [session, setSession] = useState<SessionState>({ items, index: 0 });
  const [phase, setPhase] = useState<Phase>('intro');
  const [fen, setFen] = useState<string>(() => new Chess().fen());
  const [highlight, setHighlight] = useState<string[]>([]);
  const [arrows, setArrows] = useState<BoardArrow[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [nudge, setNudge] = useState<string | null>(null);
  const [punishDone, setPunishDone] = useState(false);
  const progressRef = useRef(new Map(progress));
  const answered = useRef(0);
  const timers = useRef<number[]>([]);

  const current: SessionItem | undefined = session.items[session.index];

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  // Replay the last two moves of the line, then ask.
  useEffect(() => {
    clearTimers();
    if (!current) return;
    const moves = current.position.moves;
    const lead = Math.min(2, moves.length);
    setPhase('intro');
    setVerdict(null);
    setArrows([]);
    setNudge(null);
    setPunishDone(false);
    setHighlight([]);
    setFen(positionFen(moves.slice(0, moves.length - lead)));
    for (let i = lead - 1; i >= 0; i--) {
      const shown = moves.length - i;
      later((lead - i) * stepDelayMs, () => {
        const before = positionFen(moves.slice(0, shown - 1));
        const step = squaresOf(before, moves[shown - 1]);
        setFen(step.fen);
        setHighlight([step.from, step.to]);
        if (i === 0) setPhase('ask');
      });
    }
    if (lead === 0) setPhase('ask');
    return clearTimers;
    // A new item starts only when the index moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.index]);

  const record = useCallback(
    (outcome: Outcome) => {
      if (!current) return;
      if (answered.current === 0) markTrainedToday(now());
      if (current.isRetry) return;
      answered.current += 1;
      const id = current.drill.id;
      const next = applyAnswer(progressRef.current.get(id), id, outcome, now(), current.positionIndex);
      progressRef.current.set(id, next);
      void saveProgress(next);
    },
    [current, now],
  );

  const goShow = useCallback(() => {
    if (!current) return;
    const start = positionFen(current.position.moves);
    const best = squaresOf(start, current.position.best);
    setFen(start);
    setHighlight([]);
    setArrows([{ from: best.from, to: best.to, color: 'green' }]);
    setPhase('show');
  }, [current]);

  // Play out how his usual move gets punished.
  useEffect(() => {
    if (phase !== 'punish' || verdict?.kind !== 'usual') return;
    let at = fen;
    verdict.usual.punish.forEach((san, i) => {
      let step: { from: string; to: string; fen: string };
      try {
        step = squaresOf(at, san);
      } catch {
        return;
      }
      at = step.fen;
      later((i + 1) * stepDelayMs, () => {
        setFen(step.fen);
        setHighlight([step.from, step.to]);
        if (i === 0) setArrows([{ from: step.from, to: step.to, color: 'red' }]);
      });
    });
    later((verdict.usual.punish.length + 1) * stepDelayMs, () => setPunishDone(true));
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const onMove = (from: string, to: string): boolean => {
    if (!current) return false;
    const san = tryMove(fen, from, to);
    if (!san) return false;
    if (phase === 'ask') {
      const v = judge(current.position, san);
      const after = squaresOf(fen, san);
      setFen(after.fen);
      setHighlight([after.from, after.to]);
      setVerdict(v);
      if (v.kind === 'right') {
        setPhase('right');
      } else {
        record('wrong');
        if (v.kind === 'usual') setPhase('punish');
        else goShow();
      }
      return true;
    }
    if (phase === 'show') {
      if (!current.position.accept.includes(san)) {
        setNudge(TRAIN_COPY.followArrow);
        return false;
      }
      const after = squaresOf(fen, san);
      setFen(after.fen);
      setHighlight([after.from, after.to]);
      setArrows([]);
      setNudge(null);
      setPhase('fixed');
      return true;
    }
    return false;
  };

  const advance = (firstTryWrong: boolean) => setSession((s) => afterAnswer(s, firstTryWrong));

  if (!current) {
    return (
      <div className="app-shell train">
        <h1 className="brand-sm">{TRAIN_COPY.done}</h1>
        <button className="primary-button" onClick={() => onDone(answered.current)}>
          {TRAIN_COPY.backToTrain}
        </button>
      </div>
    );
  }

  const { drill, position } = current;
  const answeredThis = phase !== 'intro' && phase !== 'ask';

  return (
    <div className="app-shell train">
      <header className="train-header">
        <button className="link-button" onClick={() => onDone(answered.current)}>
          {TRAIN_COPY.back}
        </button>
        <span className="train-count">
          {session.index + 1} / {session.items.length}
        </span>
      </header>

      <p className="train-idea">{answeredThis ? drill.idea : ' '}</p>

      <TrainBoard
        fen={fen}
        orientation={sideToMove(position)}
        interactive={phase === 'ask' || phase === 'show'}
        onMove={onMove}
        arrows={arrows}
        highlight={highlight}
        animate={stepDelayMs > 0}
      />

      <div className="drill-text" aria-live="polite">
        {(phase === 'intro' || phase === 'ask') && (
          <div data-testid={phase === 'ask' ? 'drill-ask' : 'drill-intro'}>
            <p>{position.prompt}</p>
          </div>
        )}

        {phase === 'right' && (
          <>
            <p className="drill-good">{position.whyRight}</p>
            <div className="drill-actions">
              <button
                className="primary-button"
                onClick={() => {
                  record('right');
                  advance(false);
                }}
              >
                {TRAIN_COPY.knewIt}
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  record('guessed');
                  advance(false);
                }}
              >
                {TRAIN_COPY.guessed}
              </button>
            </div>
          </>
        )}

        {phase === 'punish' && verdict?.kind === 'usual' && (
          <>
            <p className="drill-bad">{playedTimes(verdict.usual.times)}</p>
            <p>{verdict.usual.why}</p>
            {punishDone && (
              <div className="drill-actions">
                <button className="primary-button" onClick={goShow}>
                  {TRAIN_COPY.showBetter}
                </button>
              </div>
            )}
          </>
        )}

        {phase === 'show' && (
          <>
            {verdict?.kind === 'other' && <p className="drill-bad">{TRAIN_COPY.notQuite}</p>}
            <p>{position.whyRight}</p>
            <p className="drill-cue">{nudge ?? TRAIN_COPY.yourTurn}</p>
          </>
        )}

        {phase === 'fixed' && (
          <>
            <p className="drill-good">{position.whyRight}</p>
            <div className="drill-actions">
              <button className="primary-button" onClick={() => advance(!current.isRetry)}>
                {TRAIN_COPY.next}
              </button>
            </div>
          </>
        )}
      </div>

      <p className="train-foot">{fixedInRealGames(drill.realGames.right, drill.realGames.needed)}</p>
    </div>
  );
}
