// Unit tests of what the native adapter sends, against a fake UCI program (no Stockfish needed).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeStockfish, type NativeStockfish } from './nativeStockfish';

const FEN = 'r1bqkbnr/pp1p1ppp/2n1p3/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5';
const FEN2 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';

let dir: string;
let fake: string;
let log: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-fakefish-'));
  log = join(dir, 'commands.log');
  fake = join(dir, 'fakefish.sh');
  // Logs every command and answers like a UCI engine: one line of info, then a best move.
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      `  printf '%s\\n' "$line" >> '${log}'`,
      '  case "$line" in',
      '    uci) echo "id name FakeFish"; echo "uciok";;',
      '    isready) echo "readyok";;',
      '    go*) echo "info depth 1 multipv 1 score cp 12 nodes 1 pv e2e4 e7e5"; echo "bestmove e2e4";;',
      '    quit) exit 0;;',
      '  esac',
      'done',
      '',
    ].join('\n'),
  );
  chmodSync(fake, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open: NativeStockfish[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()));
  rmSync(log, { force: true });
});
function make(opts: Parameters<typeof createNativeStockfish>[0]): NativeStockfish {
  const e = createNativeStockfish({ path: fake, ...opts });
  open.push(e);
  return e;
}
const sent = () => readFileSync(log, 'utf8').trim().split('\n');

describe('native adapter search commands', () => {
  it('depthModeSendsGoDepth: a fresh game and a fixed depth before every search', async () => {
    const engine = make({ depth: 16, threads: 1, hashMb: 64, multiPv: 3 });
    const ev = await engine.evaluate(FEN, 1500);
    await engine.evaluate(FEN2, 1500);
    expect(ev).toMatchObject({ cp: 12, bestMoveUci: 'e2e4', pvUci: ['e2e4', 'e7e5'] });
    const cmds = sent();
    expect(cmds).toContain('setoption name Threads value 1');
    expect(cmds).toContain('setoption name Hash value 64');
    expect(cmds).toContain('setoption name MultiPV value 3');
    // Each search: clear the hash (and wait until the engine is ready), set the position, fixed depth.
    const searches = cmds.slice(cmds.indexOf('isready') + 1);
    expect(searches).toEqual([
      'ucinewgame',
      'isready',
      `position fen ${FEN}`,
      'go depth 16',
      'ucinewgame',
      'isready',
      `position fen ${FEN2}`,
      'go depth 16',
    ]);
    expect(cmds.some((c) => c.startsWith('go movetime'))).toBe(false);
  });

  it('without a depth it keeps the time-limited search and the hash between searches', async () => {
    const engine = make({ movetimeMs: 30 });
    await engine.evaluate(FEN, 0);
    const cmds = sent();
    expect(cmds).toContain('go movetime 30');
    expect(cmds).not.toContain('ucinewgame');
    expect(cmds.some((c) => c.startsWith('go depth'))).toBe(false);
  });
});
