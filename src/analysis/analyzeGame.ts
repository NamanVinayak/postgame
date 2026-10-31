import { Chess } from 'chess.js';
import type { AnalysisResult, Classification, Color, PlyAnalysis } from '../types';
import { ENGINE, GREAT_MOVE, SCHEMA_VERSION } from '../constants';
import type { Engine, Evaluation } from '../services/engine/types';
import { evalToWinPct } from './winPct';
import { classifyMove, isGreatMove, isMissedWin } from './classify';
import { gameAccuracies, moveAccuracy } from './accuracy';
import { explainMistake } from './reasons';

export interface ProgressCb {
  (done: number, total: number): void;
}

function negate(evaluation: Evaluation): Evaluation {
  return {
    cp: evaluation.cp === null ? null : -evaluation.cp,
    mate: evaluation.mate === null ? null : -evaluation.mate,
    bestMoveUci: evaluation.bestMoveUci,
    secondBest: evaluation.secondBest,
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
  return { great: 0, best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
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
  const counts = { white: emptyCounts(), black: emptyCounts() };
  // White win% at each position: index 0 is the start, index i+1 is after ply i.
  const winPctWhiteSeq: number[] = [];

  /**
   * One search per distinct position: the after-position eval of ply i is the
   * same FEN as the before-position eval of ply i+1, so it is cached instead of
   * searched twice. Frees about half the wall-time for deeper searches.
   */
  const evalsByFen = new Map<string, Evaluation>();
  const evaluatePosition = async (fen: string): Promise<Evaluation> => {
    const cached = evalsByFen.get(fen);
    if (cached) return cached;
    const evaluation = await engine.evaluate(fen, ENGINE.movetimeMs);
    evalsByFen.set(fen, evaluation);
    return evaluation;
  };

  for (let i = 0; i < total; i++) {
    const move = moves[i];
    const fenBefore = move.before;
    const fenAfter = move.after;
    const moverColor: Color = move.color === 'w' ? 'white' : 'black';

    const evalBefore = await evaluatePosition(fenBefore);
    const evalAfterOpp = await evaluatePosition(fenAfter);
    const evalAfterMover = negate(evalAfterOpp);

    // Win% from the mover's point of view.
    const winBestMover = evalToWinPct(evalBefore.cp, evalBefore.mate);
    const winPlayedMover = evalToWinPct(evalAfterMover.cp, evalAfterMover.mate);
    const winPctLost = Math.max(0, winBestMover - winPlayedMover);

    const playedIsBest =
      evalBefore.bestMoveUci !== null && evalBefore.bestMoveUci === move.lan;

    let classification = classifyMove(winPctLost, playedIsBest);

    // Only one legal move: nothing was decided, always treat as best.
    let forced = false;
    try {
      forced = new Chess(fenBefore).moves().length === 1;
    } catch {
      forced = false;
    }
    if (forced) {
      classification = 'best';
    } else if (playedIsBest) {
      const winSecondBestMover = evalBefore.secondBest
        ? evalToWinPct(evalBefore.secondBest.cp, evalBefore.secondBest.mate)
        : null;
      if (isGreatMove(winBestMover, winSecondBestMover, GREAT_MOVE.minWinPctGap)) {
        classification = 'great';
      }
    }
    const missed = isMissedWin(winBestMover, winPlayedMover);
    const accuracy = moveAccuracy(winBestMover, winPlayedMover);

    const bestMoveSan = playedIsBest ? null : uciToSan(fenBefore, evalBefore.bestMoveUci);
    const opponentReplySan = uciToSan(fenAfter, evalAfterOpp.bestMoveUci);

    // Store the after-position eval from White's point of view.
    const whitePov = moverColor === 'white' ? evalAfterMover : evalAfterOpp;
    const winPctWhite = evalToWinPct(whitePov.cp, whitePov.mate);

    // Build the White-POV win% sequence: the start (before ply 0), then each after-move.
    if (i === 0) {
      // At ply 0 White is to move, so evalBefore is already White's POV.
      winPctWhiteSeq.push(evalToWinPct(evalBefore.cp, evalBefore.mate));
    }
    winPctWhiteSeq.push(winPctWhite);

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
    onProgress?.(i + 1, total);
  }

  const { white, black } = gameAccuracies(
    winPctWhiteSeq,
    plies.map((p) => ({ color: p.color, accuracy: p.accuracy })),
  );

  return {
    gameId,
    schemaVersion: SCHEMA_VERSION,
    plies,
    whiteAccuracy: white,
    blackAccuracy: black,
    counts,
    createdAt: Date.now(),
  };
}
