// Copies the single-threaded Stockfish build into public/ so it is served as a
// static asset (and works on iOS Safari, which lacks SharedArrayBuffer).
// Run automatically via the predev / prebuild npm scripts.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'stockfish', 'bin');
const to = join(root, 'public', 'stockfish');
const files = ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm'];

mkdirSync(to, { recursive: true });
for (const file of files) {
  const src = join(from, file);
  if (!existsSync(src)) {
    console.error(`[copy-stockfish] missing ${src} — is the "stockfish" dep installed?`);
    process.exit(1);
  }
  copyFileSync(src, join(to, file));
}
console.log(`[copy-stockfish] copied ${files.length} files to public/stockfish/`);
