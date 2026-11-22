/**
 * "Where your points go" (spec §6c) as the model reads it: the diagnosis text and its structured
 * copy, from P1's leak report. The same-rating area diagnosis is kept as one context line only.
 *
 * Nothing here names a move: the positions behind these numbers are practice positions, asked
 * only through the try-first flow.
 */
import { LEAK_CFG, STATS_CFG } from '../config';
import { AREA_NAMES } from '../diagnosis/areas';
import type { Diagnosis } from '../diagnosis/diagnose';
import { LEAK_LABELS, type LeakFocus, type LeakReport } from '../diagnosis/leaks';
import type { RepeatedPosition } from '../diagnosis/repeated';
import { costlyMovesText } from './views';

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const pct = (x: number) => `${Math.round(x)}%`;
const pct1 = (x: number) => x.toFixed(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The focus as the report card titles it. */
export function focusTitle(f: LeakFocus): string {
  if (f.kind === 'keepTheWin') return 'Keep the win';
  if (f.kind === 'clock') return 'Beat the clock';
  return LEAK_LABELS[f.key];
}

/** False when there is nothing to work on yet: no games, or nothing given away (the focus is then a placeholder). */
export function hasLeakFocus(r: LeakReport): boolean {
  return r.games > 0 && r.leaks.some((l) => l.sharePct > 0);
}

/** The focus in plain words for the student file ("keep the win"), or null when there is none. */
export function focusLabel(r: LeakReport): string | null {
  return hasLeakFocus(r) ? lowerFirst(focusTitle(r.focus)) : null;
}

/** Areas as the context line names them. */
const AREA_WORDS: Record<string, string> = {
  opening: 'your openings',
  middlegame: 'your middlegames',
  endgame: 'your endgames',
  converting: 'finishing off won positions',
  defending: 'holding worse positions',
  timePressure: 'moves when your clock is low',
};

const AGAINST = 'Against players at your rating (your opponents in the same games)';

/**
 * The old same-rating table as one line: the clearest gap if there is one, else that nothing
 * stands out, or that there are too few games to compare. Null without games.
 */
export function areaContext(d: Diagnosis): string | null {
  if (d.games === 0) return null;
  const f = d.focus;
  const gap =
    (f?.kind === 'area' ? d.areas.find((a) => a.area === f.area && a.label === 'gap') : undefined) ??
    d.areas.filter((a) => a.label === 'gap').sort((a, b) => b.ciAdj[0] - a.ciAdj[0])[0];
  if (gap) {
    return (
      `${AGAINST}, ${AREA_WORDS[gap.area] ?? AREA_NAMES[gap.area]} stand out: ${pct1(gap.myRate)}% of your moves there ` +
      `are serious mistakes, against ${pct1(gap.oppRate)}% (${plural(gap.games, 'game')}).`
    );
  }
  if (d.areas.length > 0 && d.areas.every((a) => a.label === 'notEnoughData')) {
    return (
      `Too few games yet to compare you with players at your rating (${plural(d.games, 'game')}; each part of the ` +
      `game needs at least ${STATS_CFG.minGames}).`
    );
  }
  return `${AGAINST}, no part of your game stands out (${plural(d.games, 'game')}).`;
}

/** "Clearly winning", in the words the player reads. */
const CLEARLY_WINNING = `winning chances of ${LEAK_CFG.winningWinPct}% or more on two of your moves in a row`;

/** Notes the text already says in its own words. */
const RESTATED = [/^Clearly winning means/, /^For context: when your opponents/, /^With fewer than \d+ games, the ranges/];

export interface LeakTextExtras {
  /** The one context line from the same-rating diagnosis (areaContext), or null. */
  context: string | null;
  /** Games per account, when several accounts are pooled. */
  gamesByAccount: { username: string; games: number }[];
  /** How many positions the player keeps reaching and getting wrong. */
  repeated: number;
}

/**
 * The diagnosis as text: the situations ranked by the share of winning chances given away (with
 * the likely range, or a plain note that ranges are hidden when they are too rough), costly moves
 * per game, keeping the win (with "clearly winning" said in plain words), losses on time, the
 * rough what-if (only when there is one; capped rating points, never the score per game), the
 * one context line, the focus and the notes. Every finding says how many games it rests on.
 */
export function leakDiagnosisText(r: LeakReport, x: LeakTextExtras): string {
  const lines: string[] = [];
  lines.push(
    `Where your points go, for ${r.usernames.join(', ')}: ${plural(r.games, `${r.timeClass} game`)} (your own games ` +
      'only; "given away" is how much your winning chances dropped with each of your moves, by the quick check).',
  );
  if (x.gamesByAccount.length > 1) lines.push(`Games per account: ${x.gamesByAccount.map((a) => `${a.username} ${a.games}`).join(', ')}.`);

  if (r.games > 0) {
    lines.push('', `Ranked by the share of the winning chances you gave away, over all ${plural(r.games, 'game')}:`);
    r.leaks.forEach((l, i) => {
      const range = r.rangesReliable ? ` (likely ${Math.round(l.shareRange[0])}–${Math.round(l.shareRange[1])}%)` : '';
      lines.push(
        `${i + 1}. ${l.label}: ${pct(l.sharePct)} of the winning chances you gave away${range}; ` +
          `${lowerFirst(costlyMovesText(l.bigMistakesPerGame))}.`,
      );
    });
    if (!r.rangesReliable) {
      lines.push(`Ranges are hidden (not enough data): with fewer than ${STATS_CFG.minGames} games they are too rough to show.`);
    }

    const c = r.conversion;
    lines.push('');
    if (c.winningGames === 0) {
      lines.push(`Keeping the win: you were never clearly winning (${CLEARLY_WINNING}) in these games.`);
    } else {
      lines.push(
        `Keeping the win: you were clearly winning (${CLEARLY_WINNING}) in ${c.winningGames} of your ` +
          `${plural(r.games, 'game')}: you won ${c.won}, drew ${c.drawn} and lost ${c.lost} of them (you kept ${pct(c.convertedPct)}).`,
      );
      const t = r.timeLosses;
      if (t.losses > 0) {
        const range = r.rangesReliable ? `, likely ${Math.round(c.lostShareRange[0])}–${Math.round(c.lostShareRange[1])}%` : '';
        lines.push(
          `${c.lost} of your ${plural(t.losses, 'loss', 'losses')} (${pct(c.lostShareOfLossesPct)}${range}) ` +
            `${c.lost === 1 ? 'was a game' : 'were games'} you were clearly winning.`,
        );
      }
      if (c.oppWinningGames > 0) {
        lines.push(
          `Your opponents were clearly winning in ${plural(c.oppWinningGames, 'game')} and won ${pct(c.oppConvertedPct)} of them.`,
        );
      }
    }
    const t = r.timeLosses;
    lines.push(
      t.losses > 0
        ? `Losses on time: ${t.onTime} of your ${plural(t.losses, 'loss', 'losses')} (${pct(t.sharePct)}) ${t.onTime === 1 ? 'was' : 'were'} on time.`
        : 'Losses on time: no losses in these games.',
    );
    if (r.whatIf) {
      lines.push(
        `What-if (rough estimate, from results alone): if you lost half as many of the games you were winning, ` +
          `about +${r.whatIf.ratingPoints} rating points.`,
      );
    }
  }

  if (x.context) lines.push('', `For context: ${lowerFirst(x.context)}`);

  lines.push('');
  if (!hasLeakFocus(r)) {
    lines.push('No focus yet: nothing given away in these games, so there is nothing to practise.');
  } else {
    const f = r.focus;
    let why: string;
    if (f.kind === 'keepTheWin') {
      why = `${r.conversion.lost} of your ${plural(r.timeLosses.losses, 'loss', 'losses')} came from games you were clearly winning`;
    } else if (f.kind === 'clock') {
      why = `${r.timeLosses.onTime} of your ${plural(r.timeLosses.losses, 'loss', 'losses')} were on time`;
    } else {
      const l = r.leaks.find((x2) => x2.key === f.key);
      why = l ? `${pct(l.sharePct)} of the winning chances you gave away went here` : 'the largest share you control';
    }
    lines.push(`Focus this week: ${focusTitle(f)} (${why}).`);
  }

  const notes = r.notes.filter((n) => !RESTATED.some((re) => re.test(n)));
  if (notes.length > 0) {
    lines.push('', 'Notes:');
    for (const n of notes) lines.push(`- ${n}`);
  }

  if (x.repeated > 0) {
    lines.push(
      '',
      `Positions you keep reaching and getting wrong: ${x.repeated} (the report card shows up to 3 as quick fixes). ` +
        "These are practice positions: don't name or show any move in them before the player has tried.",
    );
  }
  return lines.join('\n');
}

/** A repeated position as the model gets it: the board and the counts, no moves played there and no best move. */
export interface RepeatedRef {
  key: string;
  fen: string;
  movesFromStart: string[];
  seen: number;
  wrong: number;
  /** Average win-% points lost when the player went wrong there (quick check, so approximate). */
  approxAvgLossPts: number;
}

/** coach_diagnosis's structuredContent: the leak report without the uncapped score per game. */
export interface LeakDiagnosisView {
  usernames: string[];
  timeClass: string;
  games: number;
  asOf: number;
  avgScore: number;
  leaks: LeakReport['leaks'];
  conversion: LeakReport['conversion'];
  timeLosses: LeakReport['timeLosses'];
  rangesReliable: boolean;
  /** Rough estimate only, in capped rating points. */
  whatIf: { label: string; ratingPoints: number } | null;
  focus: LeakFocus;
  focusTitle: string;
  hasFocus: boolean;
  context: string | null;
  notes: string[];
  gamesByAccount: { username: string; games: number }[];
  repeated: RepeatedRef[];
}

/** Built field by field, so nothing else (an uncapped number, a move) can ride along. */
export function leakDiagnosisView(
  r: LeakReport,
  x: { context: string | null; gamesByAccount: { username: string; games: number }[]; repeated: RepeatedPosition[] },
): LeakDiagnosisView {
  return {
    usernames: [...r.usernames],
    timeClass: r.timeClass,
    games: r.games,
    asOf: r.asOf,
    avgScore: r.avgScore,
    leaks: r.leaks.map((l) => ({ ...l, shareRange: [l.shareRange[0], l.shareRange[1]] })),
    conversion: { ...r.conversion, lostShareRange: [r.conversion.lostShareRange[0], r.conversion.lostShareRange[1]] },
    timeLosses: { ...r.timeLosses },
    rangesReliable: r.rangesReliable,
    whatIf: r.whatIf ? { label: r.whatIf.label, ratingPoints: r.whatIf.ratingPoints } : null,
    focus: r.focus,
    focusTitle: focusTitle(r.focus),
    hasFocus: hasLeakFocus(r),
    context: x.context,
    notes: [...r.notes],
    gamesByAccount: x.gamesByAccount,
    repeated: x.repeated.map((p) => ({
      key: p.key,
      fen: p.fen,
      movesFromStart: [...p.movesFromStart],
      seen: p.seen,
      wrong: p.wrong,
      approxAvgLossPts: p.avgLossPts,
    })),
  };
}
