# 2026-11-23: a phone ran an old copy of the app and showed a wrong accuracy

## Symptom

A phone showed a clearly wrong accuracy for a game played that day: a 37-move rapid game won
by checkmate as Black. The winner got **37.2%** (with 0 blunders) and the loser 61.3%.
Chess.com's own review of the same game: Black 67.96, White 59.25.

## Evidence

Every row is the same game. "Re-run" means `analyzeGame` run in Node with the same lite WASM
engine the phone uses (recipe below).

| Source | Black (winner) | White |
|---|---|---|
| The phone, as it ran | 37.2 | 61.3 |
| Re-run on the **Oct 30 build** (commit `59afa0a`) | 37.3 | 62.3 |
| Re-run on the **current code** | ~82 | ~73 |
| Chess.com (`accuracies` in its public API) | 67.96 | 59.25 |

The phone's numbers match the Oct 30 build, not the code deployed that day. That build predates
the Nov 16 checkmate fix (`22741a0`): it scored the mating move from the engine's mate-0 eval,
so the winner's final move got 0% while still labelled "best", and the harmonic mean in the
accuracy formula collapsed the winner's score. It also used the old calibration exponent (1.7).
The current code scores the mating move 100%.

## Root cause

The app is a PWA (`vite-plugin-pwa`, `registerType: 'autoUpdate'`). The live site registered
its service worker with the plugin's injected `registerSW.js`, which only called
`navigator.serviceWorker.register('/postgame/sw.js')` on page load. The generated `sw.js` has
`skipWaiting()` + `clientsClaim()`, but nothing:

1. **asked for a new version while the app stayed open or came back from the background.** A
   home-screen app or phone tab that is resumed (not navigated) never re-checks; and
2. **reloaded the page when a new worker took over.** Even when the browser did install a new
   version, the open page kept running its old JavaScript.

So the phone kept executing the Oct 30 JavaScript through several deploys.

## Fix

- `src/pwa/updates.ts` registers the worker (`virtual:pwa-register`; `injectRegister: false`, so
  `registerSW.js` is gone) and checks for a new version on start, on every return to the
  foreground (`visibilitychange` to visible, and `pageshow` from the back/forward cache) and
  hourly. When a new worker takes control of a page that already had one, it reloads the page
  once, at the same URL (the game list, or the connect screen if not connected).
- **Never mid-analysis.** `ReviewScreen` holds the reload from the start of `analyzeGame` until
  the result is saved, or until the user leaves the screen. A reload can never leave a
  half-written cache entry: the result is stored with a single IndexedDB `put`, which commits
  completely or not at all; an interrupted analysis just isn't cached and runs again.
- `skipWaiting` and `clientsClaim` are now set explicitly in `vite.config.ts`. With
  `injectRegister: false` the plugin stops adding them for `autoUpdate`, and a new version
  would wait until every tab was closed.
- A version line (`Version <commit> · <build date, UTC>`) at the bottom of the connect screen
  and the game list shows which copy a device runs.

## How to check a phone

1. Open the app and scroll to the bottom of the game list. The version line's commit should
   match the latest commit on `main` that was deployed.
2. **No version line at all** means the phone still runs a build from before this fix, which
   has no update logic. Close the app completely (swipe it away in the app switcher) and open
   it again, **twice**: the first reopen still shows the old copy while the new one installs in
   the background; the second opens the new one. (Measured in the browser check below.)
3. From then on a new deploy arrives on its own within seconds of opening the app or bringing
   it back to the foreground (or within an hour if it stays open), once no analysis is running.
4. Results cached by an old build are only discarded when `SCHEMA_VERSION` differs. The Oct 30
   build wrote version 5 and the current code uses 7, so this game is re-analyzed automatically.

## Reproducing an accuracy on the current code

Use this before touching any formula (see the AGENTS.md rule).

1. Get the game's PGN and Chess.com's own `accuracies` from the public API:
   `https://api.chess.com/pub/player/<user>/games/<YYYY>/<MM>`.
2. For an old build, export that commit into a scratch folder
   (`git archive <commit> | tar -x -C <dir>`) and link `node_modules` into it.
3. Write a small Node driver (outside the repo) that implements the `Engine` interface by
   spawning `node node_modules/stockfish/bin/stockfish-18-lite-single.js` as a child process and
   speaking UCI over stdin/stdout. Mirror `src/services/engine/stockfishEngine.ts` exactly: the same
   `parseUciInfo` / `parseBestmove`, `setoption name MultiPV value 2`, then
   `position fen …` + `go movetime <ENGINE.movetimeMs>`, one search at a time. Pass it to
   `analyzeGame(pgn, engine, id)` and print `whiteAccuracy`, `blackAccuracy`, the counts, and
   any ply with accuracy under 25.
4. Run it with a TypeScript runner that resolves the extensionless imports in `src/`
   (for example `npx tsx driver.mts <code folder>`; not a project dependency). Expect about ±1
   point of run-to-run engine variance.

A winner whose accuracy collapses while showing 0 blunders means a 0% move labelled "best".
Check terminal and checkmate scoring first (regression test: `analyzeGame.test.ts`,
"delivering checkmate scores the mating move 100, not 0").

**Known gap, separate from this bug:** on this game the current code (~82 / ~73) still sits
above Chess.com (68 / 59). That's a calibration gap on one game, and one game is not a
reason to re-fit `ACCURACY_CALIBRATION_GAMMA` (re-fit recipe in `constants.ts`).

## Real-browser check for any change to the update logic

The unit tests (`src/pwa/updates.test.ts`) use a fake service worker. Changes to update logic
also need this check in a real browser (headless Chromium via Playwright, run from a scratch
folder; Playwright is not a project dependency):

1. Build the base commit and the change, each twice with different
   `GITHUB_SHA` values (`GITHUB_SHA=<fake sha> npm run build -- --base=/postgame/ --outDir=<dir>`),
   so N1 and N2 differ only in their version line.
2. Serve a build at `http://localhost:<port>/postgame/` (service workers need localhost or
   https), from a tiny Node server whose root can be swapped, with `Cache-Control: max-age=600`
   like GitHub Pages.
3. Open N1, wait for `navigator.serviceWorker.ready`, reload once (now served by the worker,
   like a returning phone) and wait ~5 s so the browser's own post-navigation check sees N1.
4. Swap the served root to N2. Simulate a return to the foreground: in the page, set
   `document.visibilityState` to hidden then visible
   (`Object.defineProperty(document, 'visibilityState', …)`) and dispatch `visibilitychange`.
5. Pass: the version line shows N2 within 10 s, after exactly one reload. With the old
   registration-only `registerSW.js` the page stays on N1, makes no `sw.js` request, and only the
   second manual reload reaches N2.
6. Mid-analysis: give the page a fixture Chess.com account (`context.route` on
   `https://api.chess.com/**`; set `postgame.username` in localStorage), open an unanalyzed
   game, swap to N2 and foreground it while "Analyzing move …" shows. Pass: no reload until the
   analysis is saved (then exactly one, and IndexedDB holds one complete entry), and leaving the
   screen mid-analysis reloads at once without writing an entry.

Results on 2026-11-23: the old registration stayed on N1 for 15 s, and reached N2 only on the
second manual reload. The fix switched in about 1.2 s with one reload. It waited through a
20-move analysis and unloaded 1 ms after the result was saved. Leaving mid-analysis reloaded
within 10 ms with no cache entry written. A device moved from the old build to the fix
needed two reopens, then took the next deploy by itself in 1.3 s.
