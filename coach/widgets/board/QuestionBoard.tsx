import type { App } from '@modelcontextprotocol/ext-apps';
import { Chess, type Square } from 'chess.js';
import { useRef, useState, type CSSProperties } from 'react';
import { parseCoachView, type CoachView } from '../../src/server/views';
import { AnswerBoard, type AnswerView } from './AnswerBoard';
import { Board, LAST_MOVE, SELECTED, TARGET, TARGET_CAPTURE, errorText, resultText } from './shared';

type QuestionView = Extract<CoachView, { kind: 'question' }>;

type Check =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'answered'; view: AnswerView }
  | { kind: 'failed'; message: string };

type Chat = 'idle' | 'drafted' | 'failed';

export const CHECK_TOOL = 'coach_check_move';
/** Claude Desktop puts this in the chat box (it doesn't send it); the player finishes the sentence. */
export const draftText = (moveSan: string) => `I played ${moveSan} here, because `;

/**
 * The question: the position with no arrows and no eval. The player makes one move (drag, or
 * tap a piece then tap where it goes). The move is then checked by the server, and the chat
 * box is pre-filled so the player can add why they chose it.
 */
export function QuestionBoard({ app, view }: { app: App; view: QuestionView }) {
  let turn: 'w' | 'b';
  try {
    turn = new Chess(view.fen).turn();
  } catch {
    return <p className="pg-p pg-error">Board error: the position can't be read.</p>;
  }
  return <Question app={app} view={view} turn={turn} />;
}

function Question({ app, view, turn }: { app: App; view: QuestionView; turn: 'w' | 'b' }) {
  const [fen, setFen] = useState(view.fen);
  const [moved, setMoved] = useState<{ san: string; from: string; to: string } | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const [chat, setChat] = useState<Chat>('idle');
  const done = useRef(false); // one move per question, even if two events land before a re-render

  const runCheck = async (moveSan: string) => {
    setCheck({ kind: 'checking' });
    try {
      const res = await app.callServerTool({
        name: CHECK_TOOL,
        arguments: { gameId: view.gameId, ply: view.ply, moveSan },
      });
      const text = resultText(res.content);
      if (res.isError) {
        setCheck({ kind: 'failed', message: text || 'the coach could not check it' });
        return;
      }
      const answer = parseCoachView(res.structuredContent);
      if (answer?.kind !== 'answer') {
        setCheck({ kind: 'failed', message: 'the check came back without a board' });
        return;
      }
      setCheck({ kind: 'answered', view: answer });
      // Best effort: lets the coach see the scored attempt when the player sends their reason.
      if (text) {
        app
          .updateModelContext({
            content: [{ type: 'text', text: `The player tried ${moveSan} on the board (game ${view.gameId}, ply ${view.ply}). Check result: ${text}` }],
          })
          .catch(() => undefined);
      }
    } catch (err) {
      setCheck({ kind: 'failed', message: errorText(err) });
    }
  };

  const draftReason = async (moveSan: string) => {
    try {
      const res = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: draftText(moveSan) }] });
      setChat(res.isError ? 'failed' : 'drafted');
    } catch {
      setChat('failed');
    }
  };

  /** Plays from→to if legal (auto-queening a promotion); returns whether the move was made. */
  const tryMove = (from: string, to: string): boolean => {
    if (done.current) return false;
    const chess = new Chess(view.fen);
    let move;
    try {
      move = chess.move({ from, to, promotion: 'q' });
    } catch {
      return false; // illegal: the piece snaps back
    }
    done.current = true;
    setFen(chess.fen());
    setMoved({ san: move.san, from: move.from, to: move.to });
    setSelected(null);
    // Both start now; neither waits for, or is blocked by, the other.
    void runCheck(move.san);
    void draftReason(move.san);
    return true;
  };

  const onSquareClick = (square: string) => {
    if (done.current) return;
    const chess = new Chess(view.fen);
    const piece = chess.get(square as Square);
    if (selected && selected !== square && tryMove(selected, square)) return;
    if (piece && piece.color === turn && selected !== square) setSelected(square as Square);
    else setSelected(null);
  };

  if (check.kind === 'answered') {
    return (
      <>
        <AnswerBoard view={check.view} />
        <ChatHint chat={chat} />
      </>
    );
  }

  const squareStyles: Record<string, CSSProperties> = {};
  if (moved) {
    squareStyles[moved.from] = LAST_MOVE;
    squareStyles[moved.to] = LAST_MOVE;
  } else if (selected) {
    squareStyles[selected] = SELECTED;
    for (const m of new Chess(view.fen).moves({ square: selected, verbose: true })) {
      squareStyles[m.to] = m.captured ? TARGET_CAPTURE : TARGET;
    }
  }

  return (
    <>
      <p className="pg-prompt">{view.prompt}</p>
      <Board
        fen={fen}
        orientation={view.orientation}
        squareStyles={squareStyles}
        interactive={{
          canDrag: (pieceType) => !moved && pieceType.startsWith(turn),
          onDrop: tryMove,
          onSquareClick,
        }}
      />
      {!moved && (
        <p className="pg-p pg-muted">
          {turn === 'w' ? 'White' : 'Black'} to move. Drag a piece, or tap it and then tap where it goes.
        </p>
      )}
      {moved && check.kind === 'checking' && <p className="pg-p">Checking {moved.san}…</p>}
      {moved && check.kind === 'failed' && (
        <p className="pg-p pg-error">
          Couldn't check {moved.san}: {check.message}
        </p>
      )}
      {moved && <ChatHint chat={chat} />}
    </>
  );
}

function ChatHint({ chat }: { chat: Chat }) {
  if (chat === 'drafted') return <p className="pg-hint">Add why you chose it, then press Enter.</p>;
  if (chat === 'failed') return <p className="pg-hint">Tell the coach your move and why in the chat.</p>;
  return null;
}
