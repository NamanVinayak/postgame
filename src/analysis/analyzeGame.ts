import { Chess } from 'chess.js';
import type { AnalysisResult, Classification, Color, PlyAnalysis } from '../types';
import { BEST_LINE_MAX_MOVES, ENGINE, GREAT_MOVE, SCHEMA_VERSION } from '../constants';
import type { Engine, Evaluation } from '../services/engine/types';
import { evalToWinPct } from './winPct';
import { classifyMove, isGreatMove, isMiss, isMissedWin } from './classify';
import { gameAccuracies, moveAccuracy } from './accuracy';
import { explainMistake } from './reasons';
import { uciLineToSan } from './lines';

export interface ProgressCb {
  (done: number, total: number): void;
}

/**
 * Flip an evaluation to the other side's point of view. Note mate 0 (the
 * side to move is already mated) must never reach here: -0 === 0, so
 * negating it is a no-op and the winner's win% would read 0 instead of 100.
 * Terminal positions are handled directly in analyzeGame instead.
 */
function negate(evaluation: Evaluation): Evaluation {
  return {
    cp: evaluation.cp === null ? null : -evaluation.cp,
    mate: evaluation.mate === null ? null : -evaluation.mate,
    bestMoveUci: evaluation.bestMoveUci,
    secondBest: evaluation.secondBest,
    // The PV is a sequence of moves — flipping the POV doesn't change it.
    pvUci: evaluation.pvUci,
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
  const missedWins = { white: 0, black: 0 };
  const misses = { white: 0, black: 0 };
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

    // Terminal after-positions are detected with chess.js, not trusted to the
    // engine: the engine reports a mated position as mate 0 (side to move is
    // mated), and negating that to the mover's POV is a no-op (-0 === 0), so
    // the winner's win% after delivering mate would read 0 instead of 100 —
    // and the harmonic mean would collapse their whole-game accuracy. There
    // is also no legal reply to search for, so skipping the eval saves one
    // movetime per terminal game.
    const afterBoard = new Chess(fenAfter);
    const isCheckmate = afterBoard.isCheckmate();
    const isStalemate = afterBoard.isStalemate();

    // Win% from the mover's point of view, plus the stored White-POV eval.
    let winPlayedMover: number;
    let winPctWhite: number;
    let storedMate: number | null;
    let storedCp: number | null;
    let opponentReplySan: string | null = null;
    if (isCheckmate || isStalemate) {
      winPlayedMover = isCheckmate ? 100 : 50;
      winPctWhite = isCheckmate ? (moverColor === 'white' ? 100 : 0) : 50;
      storedMate = isCheckmate ? 0 : null;
      storedCp = isCheckmate ? null : 0;
    } else {
      const evalAfterOpp = await evaluatePosition(fenAfter);
      const evalAfterMover = negate(evalAfterOpp);
      winPlayedMover = evalToWinPct(evalAfterMover.cp, evalAfterMover.mate);
      const whitePov = moverColor === 'white' ? evalAfterMover : evalAfterOpp;
      winPctWhite = evalToWinPct(whitePov.cp, whitePov.mate);
      storedMate = whitePov.mate;
      storedCp = whitePov.mate === null ? whitePov.cp : null;
      opponentReplySan = uciToSan(fenAfter, evalAfterOpp.bestMoveUci);
    }

    const winBestMover = evalToWinPct(evalBefore.cp, evalBefore.mate);
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
    // Missed opportunities: only when the mover had a real choice and didn't
    // play the engine's move. A missed win takes precedence over a miss —
    // a move is never both.
    const couldChoose = !forced && !playedIsBest;
    const missed = couldChoose && isMissedWin(winBestMover, winPlayedMover);
    const miss = couldChoose && !missed && isMiss(winBestMover, winPlayedMover);
    const accuracy = moveAccuracy(winBestMover, winPlayedMover);

    // No "better" move to show when the played move was (near-)optimal:
    // the engine's top choice differing by <2 win% is search noise, and
    // showing "Better: …" next to a Best badge contradicts the badge.
    const bestMoveSan =
      playedIsBest || classification === 'best' || classification === 'great'
        ? null
        : uciToSan(fenBefore, evalBefore.bestMoveUci);

    // The engine's best line from the position before this move, for the line
    // explorer. Stored in both SAN (display) and UCI (board stepping). A line
    // that fails to replay (stale/illegal PV) is dropped, not shown wrong.
    let bestLineUci: string[] | null = null;
    let bestLineSan: string[] | null = null;
    if (evalBefore.pvUci && evalBefore.pvUci.length > 0) {
      const sliced = evalBefore.pvUci.slice(0, BEST_LINE_MAX_MOVES);
      const san = uciLineToSan(fenBefore, sliced);
      if (san) {
        bestLineUci = sliced;
        bestLineSan = san;
      }
    }

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
      isMiss: miss,
      bestLeadsToMate: evalBefore.mate !== null && evalBefore.mate > 0,
      opponentReplySan,
    });

    plies.push({
      ply: i,
      moveSan: move.san,
      color: moverColor,
      evalCp: storedCp,
      mate: storedMate,
      winPctWhite,
      classification,
      isMissedWin: missed,
      isMiss: miss,
      bestMoveSan,
      bestLineSan,
      bestLineUci,
      reason,
      accuracy,
    });

    counts[moverColor][classification]++;
    if (missed) missedWins[moverColor]++;
    if (miss) misses[moverColor]++;
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
    missedWins,
    misses,
    createdAt: Date.now(),
  };
}
