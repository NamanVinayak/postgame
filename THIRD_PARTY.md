# Third-party software

Postgame's own code is MIT licensed (see [LICENSE](LICENSE)). It also uses the program
below, which keeps its own license.

## Stockfish

- **What:** the Stockfish chess engine, as the prebuilt WebAssembly build from the
  [`stockfish`](https://www.npmjs.com/package/stockfish) npm package (stockfish.js), which
  is a dependency in `package.json`.
- **How it is included:** `scripts/copy-stockfish.mjs` runs before `npm run dev` and
  `npm run build`. It copies `stockfish-18-lite-single.js` and
  `stockfish-18-lite-single.wasm` from `node_modules/stockfish/bin/` into
  `public/stockfish/`, so they are served with the app. The files are not modified. The app
  runs Stockfish as a separate program in a Web Worker and talks to it over the UCI
  protocol.
- **License:** GNU General Public License, version 3 (GPLv3), © the Stockfish developers.
  The full license text ships with the npm package (`Copying.txt`) and is at
  <https://www.gnu.org/licenses/gpl-3.0.html>.
- **Source code:**
  - Stockfish: <https://github.com/official-stockfish/Stockfish>
  - The JavaScript/WebAssembly port: <https://github.com/nmrugg/stockfish.js>

The Postgame Coach server in `coach/` calls a Stockfish program that you install
separately (for example with Homebrew). It does not bundle or distribute Stockfish.
