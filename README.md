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
  (Best / Good / Inaccuracy / Mistake / Blunder / Missed win), the engine's
  better move, plain-English explanations of the big mistakes, and a win-%
  graph you can scrub move by move.
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

The application code in this repository is released under the MIT License
(see `LICENSE`). The bundled Stockfish engine remains under its own GPLv3 license.
