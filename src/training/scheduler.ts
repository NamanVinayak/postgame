import type { CoachPack, PackDrill, PackPosition } from './pack';
import { localDay } from './day';

/** Leitner boxes 1..5 and their review intervals; box 6 = learned. */
export const BOX_INTERVAL_DAYS = [1, 3, 7, 16, 35];
export const LEARNED_BOX = 6;
export const LEARNED_INTERVAL_DAYS = 60;
export const SESSION_MAX = 10;
/** New drills introduced per calendar day, however many sessions that day. */
export const SESSION_MAX_NEW = 5;
/** With more than this many overdue, no new drills are introduced. */
export const BACKLOG_NO_NEW = 15;
export const LEECH_LAPSES = 3;
/** From this box on, reviews rotate through a drill's other positions. */
export const ROTATE_FROM_BOX = 3;

const DAY_MS = 86_400_000;

export interface DrillProgress {
  drillId: string;
  box: number;
  dueAt: number;
  lapses: number;
  reviews: number;
  lastPositionIndex: number;
  /** When the drill was first answered (absent on progress saved before this field existed). */
  introducedAt?: number;
}

export type Outcome = 'right' | 'guessed' | 'wrong';

function intervalDays(box: number): number {
  return box >= LEARNED_BOX ? LEARNED_INTERVAL_DAYS : BOX_INTERVAL_DAYS[box - 1];
}

export function applyAnswer(
  p: DrillProgress | undefined,
  drillId: string,
  outcome: Outcome,
  now: number,
  positionIndex: number = p?.lastPositionIndex ?? 0,
): DrillProgress {
  const box = p?.box ?? 0;
  let next: number;
  let lapses = p?.lapses ?? 0;
  if (outcome === 'wrong') {
    next = 1;
    lapses += 1;
  } else if (outcome === 'guessed') {
    next = Math.max(box, 1);
  } else {
    next = Math.min(box + 1, LEARNED_BOX);
  }
  return {
    drillId,
    box: next,
    dueAt: now + intervalDays(next) * DAY_MS,
    lapses,
    reviews: (p?.reviews ?? 0) + 1,
    lastPositionIndex: positionIndex,
    introducedAt: p ? p.introducedAt : now,
  };
}

export const isLeech = (p: DrillProgress): boolean => p.lapses >= LEECH_LAPSES;
export const isLearned = (p: DrillProgress): boolean => p.box >= LEARNED_BOX;

export interface SessionItem {
  drill: PackDrill;
  position: PackPosition;
  positionIndex: number;
  isNew: boolean;
  isRetry: boolean;
}

function toItem(drill: PackDrill, p: DrillProgress | undefined): SessionItem {
  const n = drill.positions.length;
  const positionIndex = p && p.box >= ROTATE_FROM_BOX ? (p.lastPositionIndex + 1) % n : 0;
  return { drill, position: drill.positions[positionIndex], positionIndex, isNew: !p, isRetry: false };
}

/** Reorder so the same opening never comes twice in a row when another order exists, keeping priority otherwise. */
function interleave(items: SessionItem[]): SessionItem[] {
  const rest = [...items];
  const out: SessionItem[] = [];
  while (rest.length) {
    const prev = out[out.length - 1]?.drill.opening;
    const i = rest.findIndex((it) => it.drill.opening !== prev);
    out.push(rest.splice(i === -1 ? 0 : i, 1)[0]);
  }
  return out;
}

/** Take drills round-robin across openings, keeping each opening's own order. */
function acrossOpenings(drills: PackDrill[]): PackDrill[] {
  const queues = new Map<string, PackDrill[]>();
  for (const d of drills) queues.set(d.opening, [...(queues.get(d.opening) ?? []), d]);
  const out: PackDrill[] = [];
  while (out.length < drills.length) {
    for (const q of queues.values()) {
      const next = q.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/** Today's session: overdue first (longest waiting first), then new drills, within the caps. */
export function buildSession(pack: CoachPack, progress: Map<string, DrillProgress>, now: number): SessionItem[] {
  const active = pack.drills.filter((d) => d.status === 'active');
  const due = active
    .filter((d) => {
      const p = progress.get(d.id);
      return p !== undefined && p.dueAt <= now;
    })
    .sort((a, b) => progress.get(a.id)!.dueAt - progress.get(b.id)!.dueAt);
  const fresh = acrossOpenings(active.filter((d) => !progress.has(d.id)));

  const today = localDay(now);
  const newToday = [...progress.values()].filter(
    (p) => p.introducedAt !== undefined && localDay(p.introducedAt) === today,
  ).length;
  const chosenDue = due.slice(0, SESSION_MAX);
  const newRoom =
    due.length > BACKLOG_NO_NEW ? 0 : Math.max(0, Math.min(SESSION_MAX_NEW - newToday, SESSION_MAX - chosenDue.length));
  const chosenNew = fresh.slice(0, newRoom);

  return interleave([
    ...chosenDue.map((d) => toItem(d, progress.get(d.id))),
    ...chosenNew.map((d) => toItem(d, undefined)),
  ]);
}
