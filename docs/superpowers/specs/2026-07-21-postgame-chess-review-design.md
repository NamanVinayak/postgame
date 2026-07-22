# Postgame — Free Chess.com Game Review Companion

**Status:** Approved design (2026-07-21)
**Working name:** Postgame (trivially renameable)

## 1. What it is

A free, mobile-first **web app (PWA)** that lets a Chess.com player review a game
they just finished — accuracy, mistakes, blunders, missed wins, and the better
move they should have played — without paying for Chess.com's Game Review.

The user keeps *playing* on Chess.com. This app is only for *understanding*
the game afterward. It is explicitly **not** a chess platform.

Primary purposes: personal use after games, a YouTube build ("I built a free
alternative to Chess.com Game Review"), and an open-source GitHub project
demonstrating what coding agents can build. No promise of long-term hosting.

## 2. Goals / Non-goals

**Goals (v1 scope)**
1. Connect a Chess.com username; the app remembers it and auto-fetches for it
   on every open. The user can **disconnect and connect a different username**
   at any time (own alt account, an opponent, a future opponent) — like log
   out / log in.
2. On open, fetch the user's recent games and show them newest-first.
3. Auto-refresh when the user returns to the app after playing.
4. Tap **Analyze** on a chosen game to run a full review on-device.
5. Show accuracy (yours vs. opponent), per-move classification, best moves,
   an eval graph, and plain-English reasons for the key mistakes.
6. Re-open a previously analyzed game instantly, without re-analyzing.

**Non-goals (deliberately excluded)**
- Playing chess, matchmaking, accounts/login, friends, messaging, puzzles,
  openings trainer, tournaments, lessons, social profiles, memberships.
- Any paid API call. The app must run 100% free and offline-capable so it can
  be open-sourced and cloned/run by anyone with no keys.
- A backend server. Everything runs client-side.

## 3. Verified external facts (Chess.com Public API)

Confirmed live on 2026-07-21 against `api.chess.com/pub`:

- **CORS:** responses send `access-control-allow-origin: *` → the browser can
  call the API directly. **No proxy/backend required.**
- **Auth:** none. Public read-only data keyed by username. No password ever.
- **Archives list:** `GET /pub/player/{username}/games/archives` → JSON
  `{ "archives": [ ".../games/2026/07", ... ] }` (one URL per month).
- **Monthly games:** `GET /pub/player/{username}/games/{YYYY}/{MM}` → `{ games: [...] }`.
  Each game object includes:
  - `pgn` (full PGN string — everything the engine needs)
  - `time_class` (`bullet` | `blitz` | `rapid` | `daily`), `time_control`
  - `end_time` (unix seconds), `rated`, `rules`, `url`, `uuid`, `eco`
  - `white` / `black`: `{ username, rating, result, uuid, @id }`
  - `accuracies` (Chess.com's own numbers — present only if *they* reviewed it;
    we do NOT depend on this, we compute our own)
- **Result vocabulary** (per side): `win`, plus loss/draw variants
  (`checkmated`, `resigned`, `timeout`, `abandoned`, `agreed`, `stalemate`,
  `repetition`, `insufficient`, `50move`, `timevsinsufficient`, `bughousepartnerlose`).
  We derive win / loss / draw for the connected user from these.
- **Etiquette:** send a descriptive `User-Agent`; archives are cacheable
  (`cache-control: public, max-age=60`).

## 4. Architecture

Pure client-side SPA. No server. Three layers:

```
UI (React)  ──►  Services  ──►  { Chess.com API,  Stockfish worker,  IndexedDB }
```

- **`chesscom` service** — fetch archives, fetch recent games, normalize a raw
  game object into an internal `GameSummary` (opponent, my color, result,
  time class, date, ids).
- **`analysis` engine** — given a PGN, drive the Stockfish Web Worker across
  every position, produce an `AnalysisResult` (see §7).
- **`storage` service** — persist the username (localStorage) and cache
  `AnalysisResult`s keyed by game id (IndexedDB) so re-open is instant.

### Stockfish choice
Use the **single-threaded WASM** build of Stockfish. It runs reliably in
iOS Safari without SharedArrayBuffer / COOP-COEP headers (which the
multi-threaded build requires and which complicate static hosting on mobile).
Runs in a **Web Worker** so the UI never freezes. Fixed budget per position
(≈ depth 15–18 or ~300–500ms movetime) → a full game ≈ 20–40s with a progress
bar. Movetime/depth is a single tunable constant.

### Board & PGN
`chess.js` parses the PGN and steps move-by-move, producing a FEN + SAN for each
ply. `react-chessboard` renders the position on the Review screen.

## 5. Screens

### 5.1 Connect / switch account
- Single input: Chess.com username. Validate via `GET /pub/player/{username}`
  (200 = exists); friendly error if not. Save as the **connected** username in
  localStorage.
- Shown on first launch and any time no account is connected.
- **Disconnect / switch:** a single control (header menu / Settings) logs out
  the current username and returns here to connect a different one — like log
  out / log in. This supports analyzing multiple accounts over time (your alt,
  an opponent, someone you're about to play).
- On every open, the app auto-fetches for the last connected username.

### 5.2 Game list (home)
- On mount shows **"Fetching your latest games…"** while loading.
- Fetches the current month's archive; if it has fewer than ~20 games, also
  fetches the previous month. Merge, sort by `end_time` desc, take the top ~20.
- Each row: opponent username + rating · time-class icon (⚡ blitz / 🕐 rapid /
  bullet / daily) · win-loss-draw color chip · date · right-side button:
  - **Analyze** if not yet analyzed
  - **{accuracy}% · View Analysis** if already analyzed (from IndexedDB)
- Newest first. Old list stays visible during refresh — never a blank screen.
- Manual pull-to-refresh / refresh button available.

### 5.3 Review
- `react-chessboard` board + move list, first/prev/next/last controls, and
  keyboard/tap scrubbing.
- **Eval graph** across the game (win-% per ply); tapping a point jumps there.
- Selected move shows: classification badge (Best / Good / Inaccuracy /
  Mistake / **Blunder** / Missed win), the **better move** (SAN) when the played
  move wasn't best, and a **plain-English reason** for significant mistakes.
- Header summary: **your accuracy vs. opponent accuracy**, plus a count of
  blunders/mistakes/inaccuracies per side.

## 6. Refresh behavior ("latest game appears automatically")

Re-fetch the recent games:
- on app open,
- whenever the app becomes visible again (`document.visibilitychange` →
  `visible`) — i.e. the user switches back after playing on Chess.com,
- on manual refresh.

After a check, briefly show **"N new game(s) found"** or **"You're up to date."**
No background polling while the app is inactive.

## 7. Analysis algorithm

For a game's PGN, for each ply from the mover's perspective:

1. Get Stockfish eval of the position **before** the move (best line + eval) and
   **after** the move actually played (eval of resulting position).
2. Convert centipawn/mate evals to **win%** via a logistic function.
3. `delta = winPct(best) − winPct(played)` for the side to move — how much the
   move gave up.
4. Classify by delta thresholds → Best / Good / Inaccuracy / Mistake / Blunder.
   Flag **Missed win** when the position was winning and the move threw most of
   it away. (Thresholds are tunable constants, tuned to feel Chess.com-like.)
5. Record the engine's preferred move (SAN) as the "better move."
6. **Plain-English reason** (heuristics, no AI): compare material before/after
   and detect the dominant cause — e.g. a now-hanging piece ("drops your
   bishop"), a large material swing, or a missed forced mate. Fallback to a
   generic "a stronger move was available" line when no clean heuristic fires.

**Accuracy score:** average per-move accuracy derived from the win-% swings,
Chess.com-style (documented approximation, not their exact proprietary formula),
computed separately for each player.

All thresholds, movetime, and the win-% conversion live in one documented
`constants` module so they're easy to tune.

## 8. Data model & persistence

- `localStorage`: `username`, app settings (e.g., analysis depth/movetime).
- `IndexedDB`: `analyses` store keyed by game id (`uuid` or `url`), holding the
  full `AnalysisResult` (per-ply evals, classifications, best moves, reasons,
  accuracies, schema version). Presence of a record = "already analyzed" →
  instant re-open, never recomputed. Keys are globally unique game ids, so
  cached analyses stay valid across account switches (analyzing an opponent
  then switching back to your own account keeps both sets of reviews).

## 9. PWA specifics

- `vite-plugin-pwa`: web manifest (name, icons, standalone display, theme color)
  + service worker.
- Service worker precaches the app shell and the Stockfish WASM so the review UI
  works offline; API calls are network-first (they need fresh data).
- Own visual identity — **must not** copy Chess.com branding, icons, colors, or
  wording.

## 10. Tech stack summary

| Concern            | Choice                                   |
|--------------------|------------------------------------------|
| Build / framework  | Vite + React + TypeScript                |
| Engine             | Stockfish single-threaded WASM (Worker)  |
| Chess logic        | chess.js                                 |
| Board UI           | react-chessboard                         |
| Charts (eval graph)| hand-rolled SVG (no chart dependency)    |
| Storage            | localStorage + IndexedDB (idb helper)    |
| PWA                | vite-plugin-pwa                          |
| Backend            | none                                      |

## 11. Risks / open items

- **Analysis speed on older phones** — mitigate with a tunable movetime and a
  clear progress bar; single-threaded keeps it universally compatible.
- **Accuracy fidelity** — ours approximates Chess.com's; label it as our own
  score, don't claim parity.
- **PGN edge cases** — variants (Chess960 etc.) are out of scope for v1; filter
  to `rules === "chess"`.
- **Rate/etiquette** — cache archives, send a descriptive User-Agent, avoid
  hammering the API on rapid visibility toggles (debounce refresh).

## 12. Definition of done (v1)

A user can: enter their username once → see recent games auto-fetched on open →
tap Analyze on a game → watch progress → read accuracy, per-move
classifications, better moves, plain-English mistake reasons, and an eval graph →
re-open that analysis later instantly. All free, client-side, open-sourceable.
