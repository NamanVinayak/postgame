# Postgame — Free Chess Game Review

A free, mobile-first web app that reviews the games you play on **Chess.com** —
accuracy, mistakes, blunders, missed wins, the better move you should have
played, and an evaluation graph — without a paid subscription.

You keep playing on Chess.com. Postgame is where you go afterward to understand
what happened.

> **Not affiliated with, endorsed by, or connected to Chess.com.** It reads only
> your **public** games through Chess.com's public API — no password, no login,
> no account on our side. This is an experimental, open-source project built for
> learning and fun, with **no guarantee of support or hosting**.

## What it does

- Connect a Chess.com username once (switch or disconnect anytime).
- Your recent games load automatically on open and when you return to the app.
- Tap **Analyze** on any game to review it on-device.
- See your accuracy vs. your opponent's, per-move classifications
  (Great / Best / Good / Inaccuracy / Mistake / Blunder / Missed win), the
  engine's better move, plain-English explanations of the big mistakes, and a
  win-% graph you can scrub move by move.
- **Great moves** (the Chess.com-style "only good move here"): when your move
  matches the engine's first choice and the second-best alternative is clearly
  worse, it gets its own teal `!` badge.
- Positions with exactly one legal move are always rated **Best** — nothing was
  decided there.
- Analyzed games are cached, so reopening one is instant.

## How it works (no backend, no keys, no cost)

Everything runs in your browser:

- **Games** come from Chess.com's public API (`api.chess.com/pub`), which is
  CORS-open, so the browser calls it directly.
- **Analysis** runs a single-threaded build of **Stockfish** compiled to
  WebAssembly, inside a Web Worker (works on iOS Safari — no SharedArrayBuffer
  required).
- **Storage** uses `localStorage` (your username) and `IndexedDB` (cached
  analyses) on your device.

It's an installable **PWA**: on iPhone, open it in Safari and "Add to Home
Screen" for an app-like icon and full-screen launch.

## Run it

```bash
npm install        # also copies the Stockfish engine into public/
npm run dev        # http://localhost:5173 (or the printed port)
```

Other scripts:

```bash
npm run build      # type-check + production build (outputs dist/)
npm run preview    # serve the production build
npm test           # run the unit test suite (Vitest)
```

## Tech stack

Vite · React · TypeScript · Stockfish (WASM, single-threaded) · chess.js ·
react-chessboard · idb · vite-plugin-pwa. Tested with Vitest +
Testing Library.

## Project layout

```
src/
  services/chesscom.ts        Fetch + normalize Chess.com games
  services/storage.ts         localStorage username + IndexedDB analysis cache
  services/engine/            Stockfish Web Worker engine
  analysis/                   win% · classification · accuracy · reasons · analyzeGame
  hooks/                      connected user, recent games
  components/                 Connect / GameList / Review screens
docs/superpowers/             Design spec and implementation plan
```

## How it was built

I designed, directed and tested Postgame, and wrote it with Claude Code as my
coding agent. The design spec and the step-by-step implementation plan it was
built from are in `docs/superpowers/`. The analysis logic is covered by unit
tests (`npm test`).

## Credits & licensing

- **Stockfish** — the chess engine, © the Stockfish contributors, licensed
  **GPLv3**. Postgame bundles the prebuilt `stockfish.js` WebAssembly engine
  (via the [`stockfish`](https://www.npmjs.com/package/stockfish) npm package)
  and communicates with it as a separate Web Worker program.
- [chess.js](https://github.com/jhlywa/chess.js) and
  [react-chessboard](https://github.com/Clariity/react-chessboard) for move
  handling and the board.

Accuracy uses the public **Lichess** method (centipawns → win%, per-move
accuracy, volatility-weighted + harmonic aggregation), then a small calibration
curve nudges the result toward **Chess.com's** stricter CAPS2 band — Chess.com's
own formula is proprietary and factors player rating, so these are an
approximation, not their exact numbers. The calibration (`ACCURACY_CALIBRATION_GAMMA`
in `src/constants.ts`) is fit to observed Chess.com samples and can be refined.

Each distinct position is searched exactly once: the eval of the position
after a move is re-used as the next move's "before" eval, which halves the
search count and lets every search go deeper (`ENGINE.movetimeMs` in
`src/constants.ts`, default 900ms). `ENGINE.multiPV = 2` also asks Stockfish
for its second-best line, which drives Great-move detection — set it back to 1
for faster analysis if you don't need those badges, or raise `movetimeMs` for
even deeper evals at the cost of review time (roughly `moves × movetimeMs`).

Want an even stronger engine? The bundled `stockfish-18-lite-single.js` is the
single-threaded, small-NNUE build (required for iOS Safari, which historically
lacked SharedArrayBuffer). The same npm package ships a heavier full-net build
(`stockfish-18-single.js`); swap the two file names in
`scripts/copy-stockfish.mjs` and `src/services/engine/stockfishEngine.ts` to
use it. True multi-threaded search would additionally require serving the app
with COOP/COEP headers to enable SharedArrayBuffer.

The application code in this repository is released under the MIT License
(see `LICENSE`). The bundled Stockfish engine remains under its own GPLv3 license.
