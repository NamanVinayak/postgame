import type { CoachPack } from './pack';
import { isLeech, type DrillProgress } from './scheduler';

const DAY_MS = 86_400_000;

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Plain-text progress report for pasting into the coaching chat. Tricky ones (leeches) first. */
export function progressSummary(pack: CoachPack, progress: Map<string, DrillProgress>, now: number): string {
  const lines = [`Coach pack from ${pack.generated} — progress on ${day(now)}`];
  const drills = pack.drills.filter((d) => d.status === 'active');

  const leeches = drills.filter((d) => {
    const p = progress.get(d.id);
    return p !== undefined && isLeech(p);
  });
  if (leeches.length) {
    lines.push('', 'Tricky ones:');
    for (const d of leeches) lines.push(`- ${d.idea} — missed ${progress.get(d.id)!.lapses} times`);
  }

  lines.push('', 'All drills:');
  for (const d of drills) {
    const p = progress.get(d.id);
    if (!p) {
      lines.push(`- ${d.idea} — not started`);
      continue;
    }
    const days = Math.ceil((p.dueAt - now) / DAY_MS);
    const due = days <= 0 ? 'due now' : `due in ${days} day${days === 1 ? '' : 's'}`;
    lines.push(`- ${d.idea} — box ${p.box}, missed ${p.lapses} times, ${due}`);
  }
  return lines.join('\n');
}
