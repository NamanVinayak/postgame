import type { Classification } from '../types';

/** Label + accent color for each move classification (own palette, not Chess.com's). */
export const CLASS_META: Record<Classification, { label: string; color: string }> = {
  best: { label: 'Best', color: '#7fa650' },
  good: { label: 'Good', color: '#9bbf7f' },
  inaccuracy: { label: 'Inaccuracy', color: '#e6c34d' },
  mistake: { label: 'Mistake', color: '#e08b3c' },
  blunder: { label: 'Blunder', color: '#d0574e' },
};

export const MISSED_WIN_META = { label: 'Missed win', color: '#c77dff' };
