import { Chess } from 'chess.js';
import { Fragment, useMemo, useState } from 'react';
import type { CoachView } from '../../src/server/views';
import { BEST_ARROW, Board, LAST_MOVE, PLAYED_ARROW, arrowFor, type Arrow } from './shared';

export type AnswerView = Extract<CoachView, { kind: 'answer' }>;

interface LineStep {
  fen: string;
  from: string;
  to: string;
}

/** The positions after each move of the best line, stopping at the first move that won't play. */
function playLine(fen: string, line: string[] | null): LineStep[] {
  if (!line) return [];
  const steps: LineStep[] = [];
  try {
    const chess = new Chess(fen);
    for (const san of line) {
      const move = chess.move(san);
      steps.push({ fen: chess.fen(), from: move.from, to: move.to });
    }
  } catch {
    // An unplayable move ends the line here; the moves before it still step.
  }
  return steps;
}

/**
 * The answer: the played move as a red arrow and the best move as a green one (just green when
 * they're the same), the caption with the win chance, and ◀ ▶ to step through the best line.
 */
export function AnswerBoard({ view }: { view: AnswerView }) {
  const steps = useMemo(() => playLine(view.fen, view.bestLineSan), [view.fen, view.bestLineSan]);
  const [step, setStep] = useState(0); // 0 = the position before the move, k = after k moves of the line
  const playedWasBest = view.bestUci === null || view.bestUci === view.playedUci;

  let arrows: Arrow[] = [];
  let squareStyles = {};
  if (step === 0) {
    const played = arrowFor(view.playedUci, playedWasBest ? BEST_ARROW : PLAYED_ARROW);
    const best = playedWasBest ? null : arrowFor(view.bestUci, BEST_ARROW);
    // Your move goes on top: on a shared line (Be7 vs Bc5) the shorter red arrow stays visible.
    arrows = [best, played].filter((a): a is Arrow => a !== null);
  } else {
    const last = steps[step - 1];
    squareStyles = { [last.from]: LAST_MOVE, [last.to]: LAST_MOVE };
  }
  const shownLine = view.bestLineSan?.slice(0, steps.length) ?? [];

  return (
    <>
      <Board fen={step === 0 ? view.fen : steps[step - 1].fen} orientation={view.orientation} arrows={arrows} squareStyles={squareStyles} />
      {view.playedSan && (
        <p className="pg-p">
          {playedWasBest ? (
            <span className="pg-best">Played {view.playedSan}: the best move</span>
          ) : (
            <>
              <span className="pg-played">Your move {view.playedSan}</span>
              {view.bestSan && (
                <>
                  {' · '}
                  <span className="pg-best">Best {view.bestSan}</span>
                </>
              )}
            </>
          )}
        </p>
      )}
      <p className="pg-p">{view.caption}</p>
      {steps.length > 0 && (
        <div className="pg-step">
          <button
            type="button"
            className="pg-button"
            aria-label="Back one move"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            ◀
          </button>
          <button
            type="button"
            className="pg-button"
            aria-label="Forward one move"
            disabled={step === steps.length}
            onClick={() => setStep((s) => Math.min(steps.length, s + 1))}
          >
            ▶
          </button>
          <p className="pg-line">
            <span className="pg-muted">Best line: </span>
            {shownLine.map((san, i) => (
              <Fragment key={i}>
                {i > 0 && ' '}
                <span className={i === step - 1 ? 'pg-now' : undefined}>{san}</span>
              </Fragment>
            ))}
          </p>
        </div>
      )}
    </>
  );
}
