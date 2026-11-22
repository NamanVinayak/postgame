// Analyses a player's recent games ahead of time so the coach answers instantly.
// Usage: npm run prewarm -- --users a,b --time-class blitz --games 300
// Real usernames are only ever passed on the command line.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { TimeClass } from '../../src/types';
import { createRunner } from '../src/analysis/runner';
import { parseFreeMemoryPct } from '../src/analysis/memoryPressure';
import { SOURCE_CFG, ensureDirs } from '../src/config';
import { createNativeStockfish } from '../src/engine/nativeStockfish';
import { createChesscomSource } from '../src/sources/chesscom';

const MIN_FREE_PCT = 20;
const TIME_CLASSES: TimeClass[] = ['bullet', 'blitz', 'rapid', 'daily'];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function checkMemory(): void {
  let out: string;
  try {
    out = execFileSync('memory_pressure', { encoding: 'utf8' });
  } catch (e) {
    fail(`Could not run memory_pressure, refusing to start: ${(e as Error).message}`);
  }
  const free = parseFreeMemoryPct(out);
  if (free === null) fail('Could not read free memory from memory_pressure, refusing to start.');
  if (free < MIN_FREE_PCT) fail(`Only ${free}% memory free (need ${MIN_FREE_PCT}%). Close some apps and retry.`);
  console.log(`Memory free: ${free}%`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      users: { type: 'string' },
      'time-class': { type: 'string', default: 'blitz' },
      games: { type: 'string', default: String(SOURCE_CFG.defaultMaxGames) },
    },
  });
  const usernames = (values.users ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if (usernames.length === 0) fail('Usage: prewarm --users a,b --time-class blitz --games 300');
  const timeClass = values['time-class'] as TimeClass;
  if (!TIME_CLASSES.includes(timeClass)) fail(`--time-class must be one of ${TIME_CLASSES.join(', ')}`);
  const maxGames = Number(values.games);
  if (!Number.isInteger(maxGames) || maxGames <= 0) fail('--games must be a positive whole number');

  checkMemory();
  ensureDirs();

  // The runner owns the engine (and recreates it if it dies); keep the latest one for the stats.
  let engine: ReturnType<typeof createNativeStockfish> | null = null;
  let searchedBefore = 0;
  const runner = createRunner(() => {
    searchedBefore += engine?.positionsSearched() ?? 0;
    return (engine = createNativeStockfish());
  }, createChesscomSource());
  const searched = () => searchedBefore + (engine?.positionsSearched() ?? 0);

  console.log(`Fetching ${maxGames} ${timeClass} games...`);
  const { jobId, total, cached } = await runner.start({ usernames, timeClass, maxGames });
  console.log(`${total} games, ${cached} already analysed, ${total - cached} to do.`);

  const t0 = Date.now();
  let lastPrinted = Math.floor(cached / 10);
  let state = runner.status(jobId);
  while (state.state === 'running') {
    await new Promise((r) => setTimeout(r, 1000));
    state = runner.status(jobId);
    if (Math.floor(state.done / 10) > lastPrinted) {
      lastPrinted = Math.floor(state.done / 10);
      console.log(`${state.done}/${state.total} games (${searched()} positions searched)`);
    }
  }
  await runner.close();

  const secs = (Date.now() - t0) / 1000;
  const positions = searched();
  console.log(
    `Finished in ${(secs / 60).toFixed(1)} min, ${positions} positions` +
      (positions > 0 ? `, ${(positions / secs).toFixed(1)} positions/s (${((secs * 1000) / positions).toFixed(0)} ms each).` : '.'),
  );
  if (state.skipped) {
    console.log(`${state.skipped} game(s) could not be analysed: ${state.skipReason} (retried on the next run).`);
  }
  if (state.state === 'error') fail(`Analysis stopped: ${state.error}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
