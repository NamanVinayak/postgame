# AGENTS.md: Postgame

A guide for AI coding agents (Claude Code, Codex, Cursor and others) and for people
reading this repo for the first time.

## What this is

Postgame is a free, mobile-first web app that reviews your Chess.com games with Stockfish,
running entirely in the browser: no backend, no API keys, no account. It is live at
<https://namanvinayak.github.io/postgame/>.

**Where it's going:** Postgame Coach, Claude + Stockfish as a personal chess coach,
delivered as a local MCP server plus a Claude Code skill. Read [ROADMAP.md](ROADMAP.md)
before proposing new features; it says what's in scope and what isn't.

## Commands

```bash
npm install     # also copies the Stockfish engine into public/stockfish/ (git-ignored)
npm run dev     # local dev server (Vite)
npm test        # Vitest unit tests; all must pass
npm run build   # type-check (tsc) + production build
```

CI (`.github/workflows/deploy.yml`) runs `npm test` and the build on every push to `main`,
then deploys to GitHub Pages under `/postgame/`.

## Map

| Path | What lives there |
|---|---|
| `src/services/chesscom.ts` | Fetch and normalize games from Chess.com's public API |
| `src/services/storage.ts` | Username in localStorage; analysis cache in IndexedDB (`SCHEMA_VERSION` in `constants.ts`) |
| `src/services/engine/` | Stockfish WebAssembly in a Web Worker, UCI parsing |
| `src/analysis/` | Win %, move classification, accuracy, plain-English reasons, best lines, `analyzeGame` |
| `src/training/` | Coach packs (`pack.ts`, `parsePack`), spaced-repetition scheduler, drill sessions |
| `src/components/`, `src/hooks/` | Connect, game list and review screens; line explorer |
| `src/constants.ts` | Every tunable number (engine time, thresholds, calibration) with comments |
| `src/pwa/updates.ts` | Service-worker registration, update checks, reload into a new version |
| `docs/incidents/` | What went wrong in production, how it was found, how to check for it |
| `docs/superpowers/` | The design spec and step-by-step plan the app was built from |

## Rules that keep it correct

- **Stockfish decides, code explains.** Never hand-tune a classification to "look right";
  change the thresholds in `constants.ts`, with a test.
- **Game-ending positions are scored by the rules, not the engine.** Checkmate and
  stalemate are handled explicitly in `analyzeGame.ts` (a past bug scored them from the
  engine's eval).
- **Each position is searched once.** The eval after a move is reused as the next move's
  "before" eval. Don't add a second search per move.
- **Accuracy calibration** (`ACCURACY_CALIBRATION_GAMMA`) is fit to real Chess.com games.
  The re-fit recipe is in the comment on the constant; don't change the number without
  re-running it.
- **iOS Safari has to keep working:** use the single-threaded "lite" engine build, with no
  SharedArrayBuffer and no COOP/COEP headers.
- **Bump `SCHEMA_VERSION`** when the shape of a cached analysis changes.
- **When accuracy looks wrong, investigate in this order before touching any formula:**
  (a) fetch Chess.com's own `accuracies` for the game from the public API
  (`/pub/player/<user>/games/<YYYY>/<MM>`); (b) re-run the game on the current code (recipe
  in [the incident note](docs/incidents/2026-11-23-old-app-copy-wrong-accuracy.md));
  (c) check which app version the device ran (the version line). A winner whose accuracy
  collapses while showing 0 blunders = a 0% move labelled "best" (the harmonic mean punishes
  it); check terminal/checkmate scoring first (regression test: `analyzeGame.test.ts`,
  "delivering checkmate…"). One game is never a reason to re-fit the calibration.
- **Phones run a cached copy of the app.** The app checks for updates on start/foreground and
  reloads into a new version (never mid-analysis). Never go back to the registration-only
  `registerSW.js`; any change to the update logic needs the real-browser check in
  [the incident note](docs/incidents/2026-11-23-old-app-copy-wrong-accuracy.md).
- **Privacy:** only public games, all processing on the device, nothing sent anywhere else.
- **Licensing:** app code is MIT. The bundled Stockfish is GPLv3, so don't modify the
  engine files; talk to them as a separate worker.

## How work is done here

Spec first, then a written plan, then the build with tests, in small commits with
`feat:` / `fix:` / `docs:` prefixes. Every change to analysis or training logic comes with
unit tests. The owner owns the architecture, specs and review; coding agents implement
against the plan, and every push to `main` runs the tests in CI.
