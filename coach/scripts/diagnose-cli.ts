// Prints the honest diagnosis for already-analysed games and writes the full JSON.
// Usage: npm run diagnose -- --users a,b --time-class blitz --games 300 --out <path>
// Real usernames are only ever passed on the command line. It never runs Stockfish:
// if games are not cached yet, run `npm run prewarm` first.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { TimeClass } from '../../src/types';
import { createRunner } from '../src/analysis/runner';
import { SOURCE_CFG } from '../src/config';
import { diagnose, type AreaFinding } from '../src/diagnosis/diagnose';
import { createChesscomSource } from '../src/sources/chesscom';

const TIME_CLASSES: TimeClass[] = ['bullet', 'blitz', 'rapid', 'daily'];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (x: number, d = 1) => x.toFixed(d);
const signed = (x: number) => (x >= 0 ? '+' : '') + num(x);
const range = (r: [number, number]) => `${signed(r[0])} to ${signed(r[1])}`;

function areaTable(areas: AreaFinding[]): string[] {
  const cols = ['area', 'label', 'you %', 'them %', 'gap pts', '95% range', 'adjusted range', 'exactP', 'games', 'my moves'];
  const rows = areas.map((a) => [
    a.area,
    a.label,
    num(a.myRate),
    num(a.oppRate),
    signed(a.gapPts),
    range(a.ci95),
    range(a.ciAdj),
    a.exactP === null ? '-' : a.exactP.toFixed(3),
    String(a.games),
    String(a.myMoves),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  return [line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      users: { type: 'string' },
      'time-class': { type: 'string', default: 'blitz' },
      games: { type: 'string', default: String(SOURCE_CFG.defaultMaxGames) },
      out: { type: 'string' },
    },
  });
  const usernames = (values.users ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if (usernames.length === 0 || !values.out) {
    fail('Usage: diagnose --users a,b --time-class blitz --games 300 --out <path>');
  }
  const timeClass = values['time-class'] as TimeClass;
  if (!TIME_CLASSES.includes(timeClass)) fail(`--time-class must be one of ${TIME_CLASSES.join(', ')}`);
  const maxGames = Number(values.games);
  if (!Number.isInteger(maxGames) || maxGames <= 0) fail('--games must be a positive whole number');

  // Analysis is not this script's job: if the runner ever asks for an engine, something is uncached.
  const runner = createRunner(() => {
    throw new Error('Games are not analysed yet. Run `npm run prewarm` with the same arguments first.');
  }, createChesscomSource());
  const q = { usernames, timeClass, maxGames };
  const { jobId, total, cached } = await runner.start(q);
  console.error(`${total} games, ${cached} already analysed.`);
  if (cached < total) {
    await runner.close();
    fail(`${total - cached} game(s) are not analysed yet. Run \`npm run prewarm\` with the same arguments first.`);
  }
  await runner.wait(jobId);
  const games = await runner.load(q);
  await runner.close();

  const d = diagnose(games, usernames);

  const out: string[] = [];
  out.push(`Diagnosis: ${d.games} ${d.timeClass} games, newest ${d.asOf ? new Date(d.asOf * 1000).toISOString().slice(0, 10) : 'n/a'}`);
  out.push('');
  out.push(...areaTable(d.areas));
  out.push('');
  out.push(
    'Focus: ' +
      (d.focus === null
        ? 'none'
        : d.focus.kind === 'area'
          ? `area ${d.focus.area}`
          : `repeated positions ${d.focus.keys.join(' | ')}`),
  );
  out.push('');
  out.push('Notes:');
  for (const n of d.notes) out.push(`- ${n}`);
  for (const a of d.areas) for (const n of a.notes.slice(1)) out.push(`- [${a.area}] ${n}`);
  out.push('');
  out.push(`Top ${Math.min(10, d.repeated.length)} repeated positions:`);
  d.repeated.slice(0, 10).forEach((r, i) => {
    const usual = r.usual.slice(0, 2).map((u) => `${u.move} x${u.times} (-${num(u.lossPts)})`).join(', ');
    out.push(
      `${i + 1}. seen ${r.seen}, wrong ${r.wrong}, avg loss ${num(r.avgLossPts)} pts, usual: ${usual}, ` +
        `best: ${r.best}, ${r.movesFromStart.length} moves from start`,
    );
    out.push(`   ${r.movesFromStart.join(' ')}`);
  });
  if (d.repeated.length === 0) out.push('(none)');

  const text = out.join('\n');
  console.log(text);
  const outPath = resolve(values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(d, null, 2) + '\n');
  console.error(`Wrote ${outPath}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
