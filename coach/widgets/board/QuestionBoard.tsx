import type { App } from '@modelcontextprotocol/ext-apps';
import { Chess, type Square } from 'chess.js';
import { useRef, useState, type CSSProperties } from 'react';
import type { CoachView } from '../../src/server/views';
import { Board, LAST_MOVE, SELECTED, TARGET, TARGET_CAPTURE } from './shared';

type QuestionView = Extract<CoachView, { kind: 'question' }>;

type Chat = 'idle' | 'drafted' | 'failed';

/** Claude Desktop puts this in the chat box (it doesn't send it); the player finishes the sentence. */
export const draftText = (moveSan: string) => `I played ${moveSan} here, because `;

/**
 * The question: the position with no arrows and no eval. The player makes one move (drag, or
 * tap a piece then tap where it goes), which only pre-fills the chat box. Try-first is strict:
 * nothing about the answer is fetched or shown here. The coach reads the player's reason and
 * then calls coach_check_move, whose result appears as a new board in answer mode.
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
  const [chat, setChat] = useState<Chat>('idle');
  const done = useRef(false); // one move at a time, even if two events land before a re-render
  const draftId = useRef(0); // ignores a late reply to the draft of a move that was changed

  const draftReason = async (moveSan: string) => {
    const id = ++draftId.current;
    let result: Chat;
    try {
      const res = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: draftText(moveSan) }] });
      result = res.isError ? 'failed' : 'drafted';
    } catch {
      result = 'failed';
    }
    if (id === draftId.current) setChat(result);
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
    setChat('idle');
    void draftReason(move.san);
    return true;
  };

  /** Back to the question position so the player can pick another move. */
  const changeMove = () => {
    done.current = false;
    draftId.current++;
    setFen(view.fen);
    setMoved(null);
    setSelected(null);
    setChat('idle');
  };

  const onSquareClick = (square: string) => {
    if (done.current) return;
    const piece = new Chess(view.fen).get(square as Square);
    if (selected && selected !== square && tryMove(selected, square)) return;
    if (piece && piece.color === turn && selected !== square) setSelected(square as Square);
    else setSelected(null);
  };

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
      {moved && (
        <div className="pg-hint pg-moved">
          <span>
            {chat === 'failed'
              ? `Your move: ${moved.san}. Tell the coach your move and why in the chat.`
              : `Your move: ${moved.san}. Now add why you chose it in the chat, then press Enter.`}
          </span>
          <button type="button" className="pg-button" onClick={changeMove}>
            Change move
          </button>
        </div>
      )}
    </>
  );
}
