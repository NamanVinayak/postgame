import type { SessionItem } from './scheduler';

export interface SessionState {
  items: SessionItem[];
  index: number;
}

/** Move to the next item; a first-time wrong answer comes back once at the end of the session. */
export function afterAnswer(state: SessionState, firstTryWrong: boolean): SessionState {
  const current = state.items[state.index];
  const items =
    firstTryWrong && current && !current.isRetry ? [...state.items, { ...current, isRetry: true }] : state.items;
  return { items, index: state.index + 1 };
}
