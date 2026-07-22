import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { EvalGraph } from './EvalGraph';
import type { PlyAnalysis } from '../types';

function ply(winPctWhite: number): PlyAnalysis {
  return {
    ply: 0,
    moveSan: 'e4',
    color: 'white',
    evalCp: 0,
    mate: null,
    winPctWhite,
    classification: 'best',
    isMissedWin: false,
    bestMoveSan: null,
    reason: null,
    accuracy: 100,
  };
}

describe('EvalGraph', () => {
  test('renders one polyline point per ply', () => {
    render(<EvalGraph plies={[ply(50), ply(60), ply(40)]} currentIndex={0} onSeek={vi.fn()} />);
    const line = screen.getByTestId('eval-line');
    const points = line.getAttribute('points')!.trim().split(/\s+/);
    expect(points).toHaveLength(3);
  });

  test('renders nothing when there are no plies', () => {
    const { container } = render(<EvalGraph plies={[]} currentIndex={0} onSeek={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
