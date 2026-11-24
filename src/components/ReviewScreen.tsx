import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { AnalysisResult, GameSummary } from '../types';
import { analyzeGame } from '../analysis/analyzeGame';
import { lineChips, linePositions } from '../analysis/lines';
import { createStockfishEngine } from '../services/engine/stockfishEngine';
import { getAnalysis, saveAnalysis } from '../services/storage';
import { holdReload } from '../pwa/updates';
import { Board } from './Board';
import { MoveBadge } from './MoveBadge';
import { EvalBar } from './EvalBar';
import { MoveList } from './MoveList';
import { EvalGraph } from './EvalGraph';
import { AccuracySummary } from './AccuracySummary';
import {
  CLASS_GLYPH,
  CLASS_META,
  MISS_GLYPH,
  MISS_META,
  MISSED_WIN_GLYPH,
  MISSED_WIN_META,
} from './classificationMeta';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface Props {
  game: GameSummary;
  myUsername: string;
  onBack: () => void;
}

function outcomeLine(game: GameSummary): string {
  const verb = game.outcome === 'win' ? 'won' : game.outcome === 'loss' ? 'lost' : 'drew';
  return `You ${verb} as ${game.myColor}`;
}

export function ReviewScreen({ game, myUsername, onBack }: Props) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [checkedCache, setCheckedCache] = useState(false);
  // Line exploration: which ply's best line is on the board, and how far
  // along it (step 0 = the position before the ply's move, step k = after
  // the first k line moves). Null means the board shows the actual game.
  const [exploring, setExploring] = useState<{ ply: number; step: number } | null>(null);
  const runningRef = useRef(false);
  const releaseReloadRef = useRef<(() => void) | null>(null);

  const { positions, moveTos } = useMemo(() => {
    try {
      const chess = new Chess();
      chess.loadPgn(game.pgn);
      const verbose = chess.history({ verbose: true });
      if (verbose.length === 0) return { positions: [chess.fen()], moveTos: [] as string[] };
      return {
        positions: [verbose[0].before, ...verbose.map((m) => m.after)],
        moveTos: verbose.map((m) => m.to),
      };
    } catch {
      return { positions: [START_FEN], moveTos: [] as string[] };
    }
  }, [game.pgn]);

  const maxIndex = positions.length - 1;

  const runAnalysis = useCallback(async () => {
    if (runningRef.current) return; // guard against double-invoke (StrictMode / rapid taps)
    runningRef.current = true;
    // A new app version waits until this analysis is saved (or the user leaves the screen).
    const releaseReload = holdReload();
    releaseReloadRef.current = releaseReload;
    setAnalyzing(true);
    setError(null);
    setProgress({ done: 0, total: Math.max(1, maxIndex) });
    const engine = createStockfishEngine();
    try {
      const result = await analyzeGame(game.pgn, engine, game.id, (done, total) =>
        setProgress({ done, total }),
      );
      await saveAnalysis(result);
      setAnalysis(result);
    } catch (e) {
      setError('Analysis failed: ' + (e as Error).message);
    } finally {
      engine.terminate();
      setAnalyzing(false);
      runningRef.current = false;
      releaseReload();
    }
  }, [game.pgn, game.id, maxIndex]);

  // Leaving mid-analysis releases the hold too (a hung engine must not pin the old version).
  // A reload then can only drop unsaved work: saveAnalysis is one IndexedDB put, all or nothing.
  useEffect(() => () => releaseReloadRef.current?.(), []);

  // Load the cached analysis; if there is none, start analyzing automatically —
  // opening an unanalyzed game already means "analyze it".
  useEffect(() => {
    setIndex(0);
    setAnalysis(null);
    setError(null);
    setCheckedCache(false);
    setExploring(null);
    let active = true;
    getAnalysis(game.id).then((cached) => {
      if (!active) return;
      setCheckedCache(true);
      if (cached) {
        setAnalysis(cached);
      } else {
        runAnalysis();
      }
    });
    return () => {
      active = false;
    };
  }, [game.id, runAnalysis]);

  const exitExploration = useCallback(() => setExploring(null), []);

  const seek = useCallback(
    (next: number) => {
      setExploring(null);
      setIndex(Math.max(0, Math.min(maxIndex, next)));
    },
    [maxIndex],
  );

  const selectedPly = analysis && index >= 1 ? analysis.plies[index - 1] : null;
  const exploringPly =
    exploring && analysis ? (analysis.plies[exploring.ply] ?? null) : null;

  // FENs along the explored line (index 0 = the position before the ply's
  // move). Null when there is no line to explore.
  const lineFens = useMemo(() => {
    if (!exploringPly?.bestLineUci || !exploring) return null;
    return linePositions(positions[exploring.ply], exploringPly.bestLineUci);
  }, [exploring, exploringPly, positions]);

  const stepLine = useCallback(
    (next: number) => {
      const max = exploringPly?.bestLineUci?.length ?? 0;
      setExploring((cur) =>
        cur ? { ...cur, step: Math.max(0, Math.min(max, next)) } : cur,
      );
    },
    [exploringPly],
  );

  const startExploring = useCallback(
    (ply: number, step: number) => {
      const plyAnalysis = analysis?.plies[ply];
      if (!plyAnalysis?.bestLineUci?.length) return;
      setIndex(ply + 1);
      setExploring({ ply, step: Math.max(0, Math.min(plyAnalysis.bestLineUci.length, step)) });
    },
    [analysis],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While exploring a line, the arrow keys walk the line, not the game.
      if (exploring) {
        if (e.key === 'ArrowLeft') stepLine(exploring.step - 1);
        if (e.key === 'ArrowRight') stepLine(exploring.step + 1);
        return;
      }
      if (e.key === 'ArrowLeft') seek(index - 1);
      if (e.key === 'ArrowRight') seek(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, seek, exploring, stepLine]);

  const badge =
    selectedPly &&
    (selectedPly.isMissedWin
      ? MISSED_WIN_META
      : selectedPly.isMiss
        ? MISS_META
        : CLASS_META[selectedPly.classification]);
  const progressPct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  // While exploring, the eval bar shows the win% at the start of the line
  // (the line's own positions have no stored evals).
  const currentWinPctWhite = exploring
    ? exploring.ply === 0
      ? 50
      : (analysis?.plies[exploring.ply - 1].winPctWhite ?? 50)
    : selectedPly
      ? selectedPly.winPctWhite
      : 50;
  const boardFen =
    exploring && lineFens ? lineFens[exploring.step] : positions[index];
  const opponentColor: typeof game.myColor = game.myColor === 'white' ? 'black' : 'white';

  return (
    <div className="app-shell review">
      <header className="review-header">
        <button className="link-button" onClick={onBack}>
          ‹ Games
        </button>
        <div className="review-title">
          <span className="opponent-name">vs {game.opponent.username}</span>
          <span className="review-sub">
            {outcomeLine(game)} · {game.timeClass}
          </span>
        </div>
      </header>

      <div className="board-block">
        <div className="player-label">
          <span className={`color-dot ${opponentColor}`} aria-hidden="true" />
          <span className="pl-name">{game.opponent.username}</span>
          <span className="pl-rating">({game.opponent.rating})</span>
        </div>

        <div className="board-row">
          <EvalBar winPctWhite={currentWinPctWhite} orientation={game.myColor} />
          <div className="board-area">
            <Board fen={boardFen} orientation={game.myColor} />
            {!exploring && selectedPly && index >= 1 && moveTos[index - 1] && (
              <MoveBadge
                square={moveTos[index - 1]}
                orientation={game.myColor}
                glyph={
                  selectedPly.isMissedWin
                    ? MISSED_WIN_GLYPH
                    : selectedPly.isMiss
                      ? MISS_GLYPH
                      : CLASS_GLYPH[selectedPly.classification]
                }
                color={
                  selectedPly.isMissedWin
                    ? MISSED_WIN_META.color
                    : selectedPly.isMiss
                      ? MISS_META.color
                      : CLASS_META[selectedPly.classification].color
                }
              />
            )}
          </div>
        </div>

        <div className="player-label">
          <span className={`color-dot ${game.myColor}`} aria-hidden="true" />
          <span className="pl-name">{myUsername}</span>
          <span className="pl-rating">({game.myRating})</span>
          <span className="pl-you">You</span>
        </div>
      </div>

      {exploring && exploringPly && (
        <div className="exploring-banner" role="status">
          <span>
            Best line instead of {exploringPly.moveSan} · move {exploring.step} of{' '}
            {exploringPly.bestLineUci?.length ?? 0}
          </span>
          <button className="link-button" onClick={exitExploration}>
            Back to game
          </button>
        </div>
      )}

      <div className="nav-controls">
        <button onClick={() => seek(0)} disabled={index === 0} aria-label="First move">
          ⏮
        </button>
        <button onClick={() => seek(index - 1)} disabled={index === 0} aria-label="Previous move">
          ‹
        </button>
        <span className="ply-counter">
          {index} / {maxIndex}
        </span>
        <button
          onClick={() => seek(index + 1)}
          disabled={index === maxIndex}
          aria-label="Next move"
        >
          ›
        </button>
        <button
          onClick={() => seek(maxIndex)}
          disabled={index === maxIndex}
          aria-label="Last move"
        >
          ⏭
        </button>
      </div>

      {checkedCache && !analysis && !analyzing && (
        <button className="analyze-big" onClick={runAnalysis}>
          {error ? 'Retry analysis' : 'Analyze this game'}
        </button>
      )}

      {analyzing && (
        <div className="progress" role="status">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span>
            Analyzing move {progress.done}/{progress.total}
          </span>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {analysis && (
        <>
          <AccuracySummary analysis={analysis} myColor={game.myColor} />

          <EvalGraph plies={analysis.plies} currentIndex={index} onSeek={seek} />

          {selectedPly && badge && (
            <div className="move-detail">
              <div className="detail-head">
                <span className="badge" style={{ backgroundColor: badge.color }}>
                  {badge.label}
                </span>
                <span className="detail-move">{selectedPly.moveSan}</span>
                {selectedPly.bestMoveSan && (
                  <span className="better">Better: {selectedPly.bestMoveSan}</span>
                )}
              </div>
              {selectedPly.reason && <p className="reason">{selectedPly.reason}</p>}
              {selectedPly.bestLineSan && selectedPly.bestLineUci && (
                <div className="best-line">
                  <div className="best-line-head">
                    <span className="best-line-label">Best line</span>
                    {exploring?.ply === selectedPly.ply ? (
                      <button className="link-button" onClick={exitExploration}>
                        Back to game
                      </button>
                    ) : (
                      <button
                        className="explore-button"
                        onClick={() => startExploring(selectedPly.ply, 1)}
                      >
                        Explore line
                      </button>
                    )}
                  </div>
                  <div className="line-chips">
                    {lineChips(selectedPly.bestLineSan, selectedPly.ply).map((chip) => (
                      <button
                        key={chip.step}
                        className={`line-chip${
                          exploring?.ply === selectedPly.ply && exploring.step === chip.step
                            ? ' active'
                            : ''
                        }`}
                        onClick={() => startExploring(selectedPly.ply, chip.step)}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                  {exploring?.ply === selectedPly.ply && (
                    <div className="line-controls">
                      <button
                        onClick={() => stepLine(exploring.step - 1)}
                        disabled={exploring.step === 0}
                        aria-label="Previous line move"
                      >
                        ‹
                      </button>
                      <span className="line-counter">
                        {exploring.step} / {selectedPly.bestLineUci.length}
                      </span>
                      <button
                        onClick={() => stepLine(exploring.step + 1)}
                        disabled={exploring.step === selectedPly.bestLineUci.length}
                        aria-label="Next line move"
                      >
                        ›
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <MoveList plies={analysis.plies} currentIndex={index} onSelect={seek} />
        </>
      )}
    </div>
  );
}
