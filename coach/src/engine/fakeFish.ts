// Test helper (not a test): a fake UCI program for the native adapter's unit tests, so they
// can check the commands it sends without Stockfish.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeFishOptions {
  /** What `uci` answers with as `id name`. */
  idName?: string;
  /** Depth reported in the info line: the depth asked for (default), or a fixed lower one (a search cut short). */
  reachDepth?: number;
  /** Seconds to wait before answering `go` (e.g. "0.3"), to look like a search that ran into its time cap. */
  sleep?: string;
}

/**
 * Writes an executable shell script at `<dir>/<name>` that logs every command to `<dir>/<name>.log`
 * and answers like a UCI engine: one scored info line, then `bestmove e2e4`.
 */
export function writeFakeFish(dir: string, name: string, o: FakeFishOptions = {}): { path: string; log: string } {
  const path = join(dir, name);
  const log = `${path}.log`;
  const depth = o.reachDepth !== undefined ? String(o.reachDepth) : '${d:-1}';
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'while IFS= read -r line; do',
      `  printf '%s\\n' "$line" >> '${log}'`,
      '  case "$line" in',
      `    uci) echo "id name ${o.idName ?? 'FakeFish 1'}"; echo "id author nobody"; echo "uciok";;`,
      '    isready) echo "readyok";;',
      '    go*)',
      `      d=$(printf '%s' "$line" | sed -n 's/.*depth \\([0-9]*\\).*/\\1/p')`,
      o.sleep ? `      sleep ${o.sleep}` : '      :',
      `      echo "info depth ${depth} seldepth 30 multipv 1 score cp 12 nodes 1 pv e2e4 e7e5"`,
      '      echo "bestmove e2e4";;',
      '    quit) exit 0;;',
      '  esac',
      'done',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { path, log };
}
