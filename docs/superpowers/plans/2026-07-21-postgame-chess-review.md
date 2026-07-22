# Postgame Chess Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a free, client-side PWA that fetches a Chess.com user's recent games and produces an on-device game review (accuracy, mistakes, blunders, better moves, eval graph, plain-English reasons).

**Architecture:** Pure client-side React SPA. A `chesscom` service fetches/normalizes games from Chess.com's public API (CORS-open, no auth). An injectable `Engine` interface fronts a Stockfish WASM Web Worker; an `analyzeGame` orchestrator walks the PGN with `chess.js` and, per ply, asks the engine for the best line and the eval of the played move, then classifies it via pure functions. Results cache in IndexedDB keyed by game id. Zero backend, zero paid calls.

**Tech Stack:** Vite + React + TypeScript, Vitest + @testing-library/react, chess.js, react-chessboard, stockfish (single-threaded WASM in a Web Worker), idb, vite-plugin-pwa, fake-indexeddb (tests).

## Global Constraints

- **No backend, no server-side code.** Everything runs in the browser.
- **No paid/authenticated API calls, no API keys.** Chess.com public API only.
- **Must run on iOS Safari** → Stockfish **single-threaded** WASM (no SharedArrayBuffer / COOP-COEP dependency).
- **Own visual identity.** Do not copy Chess.com branding, icons, colors, or exact wording.
- **Filter to standard chess:** only include games where `rules === "chess"`.
- **All tunables in one place:** thresholds, movetime, win%-conversion constants live in `src/constants.ts`.
- **TDD for pure logic**, browser-verification for UI/worker glue. Frequent commits.

---

## File Structure

```
src/
  main.tsx                      App entry
  App.tsx                       Screen router (connect | list | review) via state
  constants.ts                  Tunables: thresholds, movetime, win% params, copy
  types.ts                      Shared types (GameSummary, AnalysisResult, ...)
  services/
    chesscom.ts                 fetchArchives, fetchRecentGames, normalizeGame
    storage.ts                  username (localStorage) + analyses (IndexedDB)
    engine/
      types.ts                  Engine + Evaluation interfaces
      stockfishEngine.ts        Real Engine over a Web Worker
      stockfish.worker.ts       Worker that loads stockfish wasm, speaks UCI
    analysis/
      winPct.ts                 evalToWinPct(cp|mate) -> 0..100
      classify.ts               classifyMove(delta, flags) -> classification
      accuracy.ts               moveAccuracy(before,after); gameAccuracy(list)
      reasons.ts                explainMistake(ctx) -> string | null
      analyzeGame.ts            orchestrates Engine across a PGN -> AnalysisResult
  hooks/
    useConnectedUser.ts         connected username + connect/disconnect
    useRecentGames.ts           fetch + merge recent games, refresh, "new games" msg
  components/
    ConnectScreen.tsx
    GameList.tsx  GameRow.tsx
    ReviewScreen.tsx  Board.tsx  MoveList.tsx  EvalGraph.tsx  AccuracySummary.tsx
    ui/ (Icon.tsx, Badge.tsx, Spinner.tsx)
  styles.css
test setup: vitest.config.ts, src/test/setup.ts, src/**/*.test.ts(x)
public/: icons, stockfish assets copied at build
```

---

### Task 1: Project scaffold + test harness

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `vitest.config.ts`, `src/test/setup.ts`, `src/smoke.test.ts`

**Interfaces:**
- Produces: a runnable dev server (`npm run dev`), a passing test command (`npm test`), and a build (`npm run build`).

- [ ] **Step 1:** `npm create vite@latest . -- --template react-ts` in the (empty besides docs) dir, then install deps:
  `npm i chess.js react-chessboard idb` and
  `npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom fake-indexeddb vite-plugin-pwa`.
- [ ] **Step 2:** Configure Vitest (`environment: 'jsdom'`, `setupFiles: 'src/test/setup.ts'`, `globals: true`); setup file imports `@testing-library/jest-dom` and `fake-indexeddb/auto`.
- [ ] **Step 3:** Write `src/smoke.test.ts`: `test('math', () => expect(1+1).toBe(2))`.
- [ ] **Step 4:** Run `npm test` → PASS. Run `npm run build` → succeeds.
- [ ] **Step 5:** Replace default `App.tsx` with a minimal placeholder rendering the app name. Commit: `chore: scaffold vite react-ts pwa project with vitest`.

---

### Task 2: Shared types + constants

**Files:**
- Create: `src/types.ts`, `src/constants.ts`
- Test: `src/constants.test.ts`

**Interfaces (Produces — later tasks depend on these exact shapes):**
```ts
// types.ts
export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily';
export type Outcome = 'win' | 'loss' | 'draw';
export type Color = 'white' | 'black';

export interface GameSummary {
  id: string;            // stable unique id (game url)
  url: string;
  timeClass: TimeClass;
  endTime: number;       // unix seconds
  rated: boolean;
  myColor: Color;
  outcome: Outcome;      // from connected user's perspective
  opponent: { username: string; rating: number };
  myRating: number;
  pgn: string;
}

export type Classification =
  | 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export interface PlyAnalysis {
  ply: number;           // 0-based
  moveSan: string;
  color: Color;          // who moved
  evalCp: number | null; // played-position eval, White POV, centipawns
  mate: number | null;   // signed mate distance if forced mate, White POV
  winPctWhite: number;   // 0..100 after the move, White POV
  classification: Classification;
  isMissedWin: boolean;
  bestMoveSan: string | null;   // engine's preferred move (null if played==best)
  reason: string | null;        // plain-English, only for notable mistakes
  accuracy: number;             // 0..100 for this move (mover's POV)
}

export interface AnalysisResult {
  gameId: string;
  schemaVersion: number;
  plies: PlyAnalysis[];
  whiteAccuracy: number;
  blackAccuracy: number;
  counts: { white: Record<Classification, number>; black: Record<Classification, number> };
  createdAt: number;
}
```
```ts
// constants.ts
export const SCHEMA_VERSION = 1;
export const ENGINE = { movetimeMs: 400, multiPV: 1 };
// win% loss thresholds (percentage points) -> classification
export const DELTA = { good: 2, inaccuracy: 5, mistake: 10, blunder: 20 };
export const MISSED_WIN = { winningWinPct: 75, dropTo: 55 };
export const WINPCT_K = 0.00368208; // logistic steepness for cp->win%
export const RECENT_GAME_COUNT = 20;
```

- [ ] **Step 1:** Write `src/constants.test.ts` asserting `DELTA.mistake < DELTA.blunder` and `SCHEMA_VERSION === 1` (guards against fat-finger regressions).
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Create `types.ts` and `constants.ts` exactly as above.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: shared types and tunable constants`.

---

### Task 3: chesscom service (normalize + fetch)

**Files:**
- Create: `src/services/chesscom.ts`
- Test: `src/services/chesscom.test.ts`, `src/services/__fixtures__/games.json` (2–3 real game objects trimmed from a live archive response)

**Interfaces:**
- Consumes: `GameSummary`, `TimeClass`, `Outcome`, `Color` from `types.ts`; `RECENT_GAME_COUNT`.
- Produces:
```ts
export function normalizeGame(raw: any, username: string): GameSummary | null; // null if rules!=='chess'
export async function playerExists(username: string): Promise<boolean>;
export async function fetchArchives(username: string): Promise<string[]>;
export async function fetchRecentGames(username: string): Promise<GameSummary[]>; // newest first, top RECENT_GAME_COUNT
```

**Behavior notes for `normalizeGame`:** case-insensitive username match against `white.username`/`black.username` to find `myColor`; `outcome` from my side's `result` (`'win'` → win; `['stalemate','agreed','repetition','insufficient','50move','timevsinsufficient']` → draw; everything else → loss); `id = raw.url`. `fetchRecentGames`: fetch archives, take last archive, map+filter via `normalizeGame`; if fewer than `RECENT_GAME_COUNT`, also fetch the previous archive; sort by `endTime` desc; slice to `RECENT_GAME_COUNT`. All fetches send header `Accept: application/json` (no custom User-Agent — browsers forbid setting it).

- [ ] **Step 1:** Save 2–3 trimmed real game objects (one white win, one black loss, one draw or a `rules:"chess960"` to prove filtering) into the fixture file.
- [ ] **Step 2:** Write tests: `normalizeGame` returns correct `myColor`/`outcome`/`opponent` for each fixture; returns `null` for the non-standard-rules fixture. (`fetch`-based functions: test `normalizeGame` purely; do a single live-network smoke test guarded so it can be skipped offline.)
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement `chesscom.ts`.
- [ ] **Step 5:** Run → PASS. Commit: `feat: chess.com game fetching and normalization`.

---

### Task 4: storage service (username + analyses cache)

**Files:**
- Create: `src/services/storage.ts`
- Test: `src/services/storage.test.ts` (uses `fake-indexeddb/auto` from setup)

**Interfaces:**
- Consumes: `AnalysisResult`, `SCHEMA_VERSION`.
- Produces:
```ts
export function getUsername(): string | null;
export function setUsername(name: string): void;
export function clearUsername(): void;              // disconnect
export async function getAnalysis(gameId: string): Promise<AnalysisResult | null>; // null if missing OR stale schema
export async function saveAnalysis(result: AnalysisResult): Promise<void>;
export async function getAnalyzedIds(ids: string[]): Promise<Set<string>>; // which of these are cached (fresh schema)
```

- [ ] **Step 1:** Tests: set/get/clear username via localStorage; save then get an `AnalysisResult` round-trips; `getAnalysis` returns `null` when stored `schemaVersion` differs; `getAnalyzedIds` returns only cached ids.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement using `idb` (`openDB('postgame', 1, { upgrade(db){ db.createObjectStore('analyses', {keyPath:'gameId'}) }})`) and `localStorage` for the username.
- [ ] **Step 4:** Run → PASS. Commit: `feat: localStorage username + IndexedDB analysis cache`.

---

### Task 5: win% + classification + accuracy (pure math)

**Files:**
- Create: `src/analysis/winPct.ts`, `src/analysis/classify.ts`, `src/analysis/accuracy.ts`
- Test: one `*.test.ts` beside each.

**Interfaces:**
- Consumes: `WINPCT_K`, `DELTA`, `MISSED_WIN`, `Classification`.
- Produces:
```ts
// winPct.ts  (all White-POV in, 0..100 out)
export function evalToWinPct(cp: number | null, mate: number | null): number;
// classify.ts (deltas in percentage points, mover-POV)
export function classifyMove(winPctLost: number, playedIsBest: boolean): Classification;
export function isMissedWin(winBeforeMover: number, winAfterMover: number): boolean;
// accuracy.ts
export function moveAccuracy(winBeforeMover: number, winAfterMover: number): number; // 0..100
export function gameAccuracy(moveAccuracies: number[]): number; // mean, 0..100, 100 if empty
```

**Formulas (implement exactly):**
- `evalToWinPct`: if `mate!=null` → `mate>0?100:0`; else `50 + 50*(2/(1+Math.exp(-WINPCT_K*cp)) - 1)`, clamped `[0,100]`.
- `classifyMove`: if `playedIsBest || lost<DELTA.good` → 'best'; else `<DELTA.inaccuracy` → 'good'; `<DELTA.mistake` → 'inaccuracy'; `<DELTA.blunder` → 'mistake'; else 'blunder'.
- `isMissedWin`: `winBefore>=MISSED_WIN.winningWinPct && winAfter<=MISSED_WIN.dropTo`.
- `moveAccuracy`: `clamp(103.1668*Math.exp(-0.04354*(winBefore-winAfter)) - 3.1669, 0, 100)`.

- [ ] **Step 1:** Tests with known points: `evalToWinPct(0,null)===50`; large +cp → ~100; `mate=1` → 100; `mate=-1` → 0. `classifyMove(0,true)==='best'`; `classifyMove(25,false)==='blunder'`; `classifyMove(7,false)==='inaccuracy'`. `moveAccuracy(50,50)` ≈ 100; big drop → low. `gameAccuracy([])===100`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the three modules per formulas.
- [ ] **Step 4:** Run → PASS. Commit: `feat: win% conversion, move classification, accuracy scoring`.

---

### Task 6: plain-English reasons (heuristics)

**Files:**
- Create: `src/analysis/reasons.ts`
- Test: `src/analysis/reasons.test.ts`

**Interfaces:**
- Consumes: `Classification`, `chess.js`.
- Produces:
```ts
export interface ReasonCtx {
  fenBefore: string;          // position before the played move
  fenAfter: string;           // position after the played move
  playedSan: string;
  bestMoveSan: string | null;
  classification: Classification;
  isMissedWin: boolean;
  bestLeadsToMate: boolean;   // engine best line was a forced mate the player missed
  opponentReplySan: string | null; // engine's best reply for the opponent from fenAfter
}
export function explainMistake(ctx: ReasonCtx): string | null; // null when nothing notable
```

**Heuristic order (first match wins). Only produce a reason for `blunder`/`mistake`/`isMissedWin`; else return `null`:**
1. `isMissedWin && bestLeadsToMate` → `"You missed a forced checkmate — {bestMoveSan} was winning."`
2. `isMissedWin` → `"You had a strong move here — {bestMoveSan} kept your advantage."`
3. Hanging-piece: apply `opponentReplySan` to `fenAfter` with chess.js; if it's a capture of a piece whose square, before that capture, is **not defended** by the mover (use the actual chess.js attacker API verified during Task setup) and captured value ≥ minor piece → `"This leaves your {pieceName} hanging — after {opponentReplySan} it's lost."`
4. Fallback (blunder/mistake): `"A stronger move was {bestMoveSan}."` (omit clause if `bestMoveSan` null → `"A stronger move was available."`).

- [ ] **Step 1:** Write tests for cases 1, 2, and 4 with hand-built FENs (these need no engine). For case 3, construct a FEN where a queen sits on a square attacked by an undefended pawn capture and assert the "hanging" phrasing; **during implementation, verify chess.js's real attacker/defender API** (`new Chess(fen).attackers?` / `.isAttacked?` / fallback: scan `moves({verbose:true})` for a recapture) and code case 3 against what actually exists.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `reasons.ts`; add a small `pieceName(type)` map.
- [ ] **Step 4:** Run → PASS. Commit: `feat: heuristic plain-English mistake explanations`.

---

### Task 7: analyzeGame orchestrator (injectable engine)

**Files:**
- Create: `src/services/engine/types.ts`, `src/analysis/analyzeGame.ts`
- Test: `src/analysis/analyzeGame.test.ts` (uses a **fake engine**, no WASM)

**Interfaces:**
```ts
// engine/types.ts
export interface Evaluation { cp: number | null; mate: number | null; bestMoveUci: string | null; } // side-to-move POV
export interface Engine { evaluate(fen: string, movetimeMs: number): Promise<Evaluation>; }
```
```ts
// analyzeGame.ts
export interface ProgressCb { (done: number, total: number): void; }
export async function analyzeGame(
  pgn: string, engine: Engine, gameId: string, onProgress?: ProgressCb
): Promise<AnalysisResult>;
```
- Consumes: `Engine`, `Evaluation`, everything from Task 5/6, `chess.js`, `ENGINE`, `SCHEMA_VERSION`.
- Produces: `analyzeGame` (consumed by ReviewScreen, Task 12).

**Orchestration (per ply i):** load PGN with chess.js; replay to position before ply i (`fenBefore`, side to move = mover). `evaluate(fenBefore)` → best line + `bestMoveUci` (convert to SAN via a temp `chess.move`). Play the actual move → `fenAfter`; `evaluate(fenAfter)` → opponent-POV eval → negate to mover POV = played eval. Convert both to **White-POV** for storage (`winPctWhite`, `evalCp`, `mate`) and to **mover-POV** win% for `delta`/`accuracy`/classification. `playedIsBest = bestMoveUci === actualMoveUci`. Build `PlyAnalysis`; feed a `ReasonCtx` to `explainMistake` (compute `opponentReplySan` from a cheap best-move on `fenAfter`, which we already have). Call `onProgress(i+1, total)`. Aggregate accuracies per color → `gameAccuracy`; tally `counts`.

- [ ] **Step 1:** Test with a short hard-coded PGN (~6–8 plies) and a **deterministic FakeEngine** returning scripted evals so one move is a clear blunder. Assert: correct `plies.length`, the blunder ply has `classification:'blunder'` and a non-null `reason`, and `whiteAccuracy`/`blackAccuracy` are within `[0,100]`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `analyzeGame.ts` + `engine/types.ts`.
- [ ] **Step 4:** Run → PASS. Commit: `feat: analyzeGame orchestrator over injectable engine`.

---

### Task 8: Stockfish Web Worker engine (real Engine)

**Files:**
- Create: `src/services/engine/stockfish.worker.ts`, `src/services/engine/stockfishEngine.ts`
- Modify: `vite.config.ts` (ensure worker + wasm asset handling; copy stockfish asset to `public/` or import as worker)

**Interfaces:**
- Produces: `export function createStockfishEngine(): Engine` — real `Engine` (Task 7 shape) backed by the worker. UCI flow: `uci`→`isready`→`position fen ...`→`go movetime N`; parse `info ... score cp X|mate Y ... pv <first>` and final `bestmove <uci>`; resolve `Evaluation` on `bestmove`. Serialize calls (one eval at a time) via an internal queue.

- [ ] **Step 1:** Wire the single-threaded `stockfish` build into a Web Worker; `stockfishEngine.ts` posts commands and parses output into `Evaluation`.
- [ ] **Step 2:** **Browser verification** (no unit test — worker/WASM): add a temporary dev-only button that runs `createStockfishEngine().evaluate(START_FEN, 400)` and logs the result; open the app in the in-app browser and confirm a sane eval (~cp near 0..40, a legal `bestMoveUci` like `e2e4`). Remove the temp button after confirming.
- [ ] **Step 3:** Commit: `feat: stockfish wasm web worker engine`.

---

### Task 9: App shell + connected-user hook

**Files:**
- Create: `src/hooks/useConnectedUser.ts`; rewrite `src/App.tsx`; `src/components/ui/*`
- Test: `src/hooks/useConnectedUser.test.tsx`

**Interfaces:**
- Consumes: storage (`getUsername/setUsername/clearUsername`).
- Produces: `useConnectedUser()` → `{ username, connect(name), disconnect() }`; `App` renders ConnectScreen when `username==null`, else GameList, and swaps to ReviewScreen when a game is selected (screen state held in App).

- [ ] **Step 1:** Test the hook: starts from stored username; `connect` persists + updates; `disconnect` clears.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement hook + App routing (simple `useState` screen switch; no router lib). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: app shell and connected-user state`.

---

### Task 10: Connect / switch-account screen

**Files:**
- Create: `src/components/ConnectScreen.tsx`
- Test: `src/components/ConnectScreen.test.tsx`

**Interfaces:** Consumes `playerExists` (chesscom) + `connect` (from App/hook). Props: `{ onConnect(name): void }`. Validates non-empty → `playerExists` → on success `onConnect(name)`, on failure shows inline error. Shows a loading state while checking.

- [ ] **Step 1:** Test (mock `playerExists`): typing a valid name + submit calls `onConnect`; an unknown name shows the error and does not call `onConnect`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat: connect / switch account screen`.

---

### Task 11: Game list + rows + recent-games hook + auto-refresh

**Files:**
- Create: `src/hooks/useRecentGames.ts`, `src/components/GameList.tsx`, `src/components/GameRow.tsx`
- Test: `src/hooks/useRecentGames.test.tsx`, `src/components/GameRow.test.tsx`

**Interfaces:**
- Consumes: `fetchRecentGames`, `getAnalyzedIds`, `GameSummary`.
- Produces: `useRecentGames(username)` → `{ games, analyzedIds, status, statusMessage, refresh }` where `status ∈ 'idle'|'loading'|'error'`; merges newly-fetched games above existing (dedupe by id), keeps old list visible during refresh, sets `statusMessage` to `"N new game(s) found"` / `"You're up to date"`. Refresh fires on mount and on `document.visibilitychange==='visible'` (debounced).

- [ ] **Step 1:** Test `useRecentGames` (mock chesscom + storage): initial load populates games + `analyzedIds`; a second refresh returning one extra game sets `"1 new game found"` and prepends it. Test `GameRow` renders opponent, a time-class icon, an outcome chip, and an "Analyze" button (or accuracy% when analyzed).
- [ ] **Step 2:** FAIL → **Step 3:** implement (GameList maps rows, shows "Fetching your latest games…" on first load, wires visibility refresh) → **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat: game list with auto-refresh and analyzed-state`.

---

### Task 12: Review screen (board, moves, eval graph, accuracy, run+cache)

**Files:**
- Create: `src/components/ReviewScreen.tsx`, `Board.tsx`, `MoveList.tsx`, `EvalGraph.tsx`, `AccuracySummary.tsx`
- Test: `src/components/EvalGraph.test.tsx`, `src/components/AccuracySummary.test.tsx`

**Interfaces:**
- Consumes: `analyzeGame` + `createStockfishEngine` (run on demand), `getAnalysis`/`saveAnalysis` (cache), `GameSummary`, `AnalysisResult`, `chess.js` (for stepping FENs), `react-chessboard`.
- Behavior: on open, `getAnalysis(game.id)`; if cached → render immediately; else show **Analyze** button → on click run `analyzeGame(pgn, engine, id, onProgress)` with a "Analyzing move X/Y" progress bar, then `saveAnalysis`. Render: board at current ply, prev/next/first/last controls, `MoveList` (click to jump; badge per move), `EvalGraph` (win% line, tap-to-jump), `AccuracySummary` (your% vs opp%, per-side blunder/mistake/inaccuracy counts). Selected move shows classification badge, better move, and `reason` when present.

- [ ] **Step 1:** Unit-test the two pure-ish presentational pieces: `EvalGraph` given a plies array renders one `<polyline>`/points of correct length; `AccuracySummary` shows the two accuracy numbers and correct counts. (Board/worker flow verified in-browser at Task 14.)
- [ ] **Step 2:** FAIL → **Step 3:** implement all five components + wiring → **Step 4:** unit tests PASS.
- [ ] **Step 5:** Commit: `feat: review screen with analysis, eval graph, accuracy`.

---

### Task 13: PWA packaging (installable, offline shell)

**Files:**
- Modify: `vite.config.ts` (add `vite-plugin-pwa` with manifest: name "Postgame", standalone, theme color, own icons); Create: `public/icons/*` (simple generated icons), `src/styles.css` polish for mobile.

**Interfaces:** Produces an installable PWA; service worker precaches app shell + Stockfish wasm; API calls network-first.

- [ ] **Step 1:** Configure `VitePWA({ registerType:'autoUpdate', manifest:{...}, workbox:{ globPatterns:['**/*.{js,css,html,wasm}'] }})`.
- [ ] **Step 2:** `npm run build` succeeds and emits a manifest + service worker.
- [ ] **Step 3:** Commit: `feat: installable PWA with offline app shell`.

---

### Task 14: End-to-end browser verification + README

**Files:**
- Create: `README.md` (what it is, "not affiliated with Chess.com", run instructions, open-source note); modify any bugs found.

- [ ] **Step 1:** `npm run build` and serve; in the in-app browser: enter a real username → games load → **Analyze** a real short game → progress runs → accuracy, badges, better moves, reasons, and eval graph all render → reopen the game → loads instantly from cache → disconnect → connect a different username → its games load.
- [ ] **Step 2:** Fix anything broken; keep tests green (`npm test`).
- [ ] **Step 3:** Write `README.md`. Commit: `docs: README and end-to-end verification`.

---

## Self-Review

- **Spec coverage:** connect/switch (T9/T10), auto-fetch on open+return (T11), analyze on demand (T12), accuracy/mistakes/blunders/better-moves/eval-graph (T5/T7/T12), plain-English reasons (T6), instant re-open from cache (T4/T12), PWA/offline (T13), no backend/no paid calls (global), rules-filter (T3), own branding (T13/T14). All covered.
- **Placeholders:** none — formulas and interfaces are concrete; the two genuinely library-dependent spots (chess.js attacker API in T6, worker/WASM glue in T8) are explicitly flagged to be coded against the real installed API and verified in-browser rather than guessed.
- **Type consistency:** `Engine`/`Evaluation` defined in T7's `engine/types.ts` and reused verbatim in T8; `GameSummary`/`AnalysisResult`/`PlyAnalysis`/`Classification` defined in T2 and referenced unchanged throughout.
