import { Chess } from 'chess.js';
import type { AnalysisResult, Classification, Color, PlyAnalysis } from '../types';
import { ENGINE, SCHEMA_VERSION } from '../constants';
import type { Engine, Evaluation } from '../services/engine/types';
import { evalToWinPct } from './winPct';
import { classifyMove, isMissedWin } from './classify';
import { gameAccuracy, moveAccuracy } from './accuracy';
import { explainMistake } from './reasons';

export interface ProgressCb {
  (done: number, total: number): void;
}

function negate(evaluation: Evaluation): Evaluation {
  return {
    cp: evaluation.cp === null ? null : -evaluation.cp,
    mate: evaluation.mate === null ? null : -evaluation.mate,
    bestMoveUci: evaluation.bestMoveUci,
  };
}

/** Convert a UCI move to SAN in the given position; null if illegal/unparseable. */
function uciToSan(fen: string, uci: string | null): string | null {
  if (!uci) return null;
  try {
    const board = new Chess(fen);
    const move = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move.san;
  } catch {
    return null;
  }
}

function emptyCounts(): Record<Classification, number> {
  return { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
}

/**
 * Walk a game's PGN with the engine and produce a full AnalysisResult.
 * For each ply the engine evaluates the position before the move (best line,
 * mover POV) and after the move (opponent POV, negated to mover POV); the win%
 * swing drives classification, accuracy, and the plain-English reason.
 */
export async function analyzeGame(
  pgn: string,
  engine: Engine,
  gameId: string,
  onProgress?: ProgressCb,
): Promise<AnalysisResult> {
  const loaded = new Chess();
  loaded.loadPgn(pgn);
  const moves = loaded.history({ verbose: true });
  const total = moves.length;

  const plies: PlyAnalysis[] = [];
  const whiteAccuracies: number[] = [];
  const blackAccuracies: number[] = [];
  const counts = { white: emptyCounts(), black: emptyCounts() };

  for (let i = 0; i < total; i++) {
    const move = moves[i];
    const fenBefore = move.before;
    const fenAfter = move.after;
    const moverColor: Color = move.color === 'w' ? 'white' : 'black';

    const evalBefore = await engine.evaluate(fenBefore, ENGINE.movetimeMs);
    const evalAfterOpp = await engine.evaluate(fenAfter, ENGINE.movetimeMs);
    const evalAfterMover = negate(evalAfterOpp);

    // Win% from the mover's point of view.
    const winBestMover = evalToWinPct(evalBefore.cp, evalBefore.mate);
    const winPlayedMover = evalToWinPct(evalAfterMover.cp, evalAfterMover.mate);
    const winPctLost = Math.max(0, winBestMover - winPlayedMover);

    const playedIsBest =
      evalBefore.bestMoveUci !== null && evalBefore.bestMoveUci === move.lan;
    const classification = classifyMove(winPctLost, playedIsBest);
    const missed = isMissedWin(winBestMover, winPlayedMover);
    const accuracy = moveAccuracy(winBestMover, winPlayedMover);

    const bestMoveSan = playedIsBest ? null : uciToSan(fenBefore, evalBefore.bestMoveUci);
    const opponentReplySan = uciToSan(fenAfter, evalAfterOpp.bestMoveUci);

    // Store the after-position eval from White's point of view.
    const whitePov = moverColor === 'white' ? evalAfterMover : evalAfterOpp;
    const winPctWhite = evalToWinPct(whitePov.cp, whitePov.mate);

    const reason = explainMistake({
      fenBefore,
      fenAfter,
      playedSan: move.san,
      bestMoveSan,
      classification,
      isMissedWin: missed,
      bestLeadsToMate: evalBefore.mate !== null && evalBefore.mate > 0,
      opponentReplySan,
    });

    plies.push({
      ply: i,
      moveSan: move.san,
      color: moverColor,
      evalCp: whitePov.mate === null ? whitePov.cp : null,
      mate: whitePov.mate,
      winPctWhite,
      classification,
      isMissedWin: missed,
      bestMoveSan,
      reason,
      accuracy,
    });

    counts[moverColor][classification]++;
    (moverColor === 'white' ? whiteAccuracies : blackAccuracies).push(accuracy);
    onProgress?.(i + 1, total);
  }

  return {
    gameId,
    schemaVersion: SCHEMA_VERSION,
    plies,
    whiteAccuracy: gameAccuracy(whiteAccuracies),
    blackAccuracy: gameAccuracy(blackAccuracies),
    counts,
    createdAt: Date.now(),
  };
}
