import { useEffect, useRef } from 'react';
import type { PlyAnalysis } from '../types';
import { CLASS_META } from './classificationMeta';

interface Props {
  plies: PlyAnalysis[];
  /** 0 = start, k = after ply k. */
  currentIndex: number;
  onSelect: (index: number) => void;
}

export function MoveList({ plies, currentIndex, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const active = activeRef.current;
    if (!container || !active) return;
    // Scroll *within* the move list only — never scroll the page.
    const activeTop = active.offsetTop - container.offsetTop;
    const activeBottom = activeTop + active.offsetHeight;
    if (activeTop < container.scrollTop) {
      container.scrollTop = activeTop;
    } else if (activeBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = activeBottom - container.clientHeight;
    }
  }, [currentIndex]);

  // Group into full moves: [whitePly, blackPly?].
  const rows: Array<{ moveNo: number; white?: PlyAnalysis; black?: PlyAnalysis }> = [];
  plies.forEach((p, i) => {
    const moveNo = Math.floor(i / 2) + 1;
    if (i % 2 === 0) rows.push({ moveNo, white: p });
    else rows[rows.length - 1].black = p;
  });

  function cell(p: PlyAnalysis | undefined, index: number) {
    if (!p) return <span className="move-cell empty" />;
    const active = currentIndex === index + 1;
    const meta = CLASS_META[p.classification];
    return (
      <button
        ref={active ? activeRef : undefined}
        className={`move-cell${active ? ' active' : ''}`}
        onClick={() => onSelect(index + 1)}
      >
        <span className="move-dot" style={{ backgroundColor: meta.color }} />
        {p.moveSan}
      </button>
    );
  }

  return (
    <div className="move-list" ref={containerRef}>
      {rows.map((row) => (
        <div className="move-row" key={row.moveNo}>
          <span className="move-no">{row.moveNo}.</span>
          {cell(row.white, (row.moveNo - 1) * 2)}
          {cell(row.black, (row.moveNo - 1) * 2 + 1)}
        </div>
      ))}
    </div>
  );
}
