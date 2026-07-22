import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { AnalysisResult, GameSummary } from '../types';
import { analyzeGame } from '../analysis/analyzeGame';
import { createStockfishEngine } from '../services/engine/stockfishEngine';
import { getAnalysis, saveAnalysis } from '../services/storage';
import { Board } from './Board';
import { MoveBadge } from './MoveBadge';
import { EvalBar } from './EvalBar';
import { MoveList } from './MoveList';
import { EvalGraph } from './EvalGraph';
import { AccuracySummary } from './AccuracySummary';
import {
  CLASS_GLYPH,
  CLASS_META,
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
  const runningRef = useRef(false);

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
    }
  }, [game.pgn, game.id, maxIndex]);

  // Load the cached analysis; if there is none, start analyzing automatically —
  // opening an unanalyzed game already means "analyze it".
  useEffect(() => {
    setIndex(0);
    setAnalysis(null);
    setError(null);
    setCheckedCache(false);
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

  const seek = useCallback(
    (next: number) => setIndex(Math.max(0, Math.min(maxIndex, next))),
    [maxIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') seek(index - 1);
      if (e.key === 'ArrowRight') seek(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, seek]);

  const selectedPly = analysis && index >= 1 ? analysis.plies[index - 1] : null;
  const badge =
    selectedPly &&
    (selectedPly.isMissedWin ? MISSED_WIN_META : CLASS_META[selectedPly.classification]);
  const progressPct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  const currentWinPctWhite = selectedPly ? selectedPly.winPctWhite : 50;
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
            <Board fen={positions[index]} orientation={game.myColor} />
            {selectedPly && index >= 1 && moveTos[index - 1] && (
              <MoveBadge
                square={moveTos[index - 1]}
                orientation={game.myColor}
                glyph={
                  selectedPly.isMissedWin
                    ? MISSED_WIN_GLYPH
                    : CLASS_GLYPH[selectedPly.classification]
                }
                color={
                  selectedPly.isMissedWin
                    ? MISSED_WIN_META.color
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
            </div>
          )}

          <MoveList plies={analysis.plies} currentIndex={index} onSelect={seek} />
        </>
      )}
    </div>
  );
}
