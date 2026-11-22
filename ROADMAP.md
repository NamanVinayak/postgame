# Roadmap: Postgame Coach

*Updated November 22, 2026. Everything below "What exists today" is planned work and not built yet.*

**The goal:** turn Claude and Stockfish into a personal chess coach that reads every game
you've played, finds the one thing actually holding you back, explains it in a way you
understand, and drills it until it's fixed. It should be free, run locally, and install
in Claude Code with one line.

## Scope and intent

- **Who it's for:** club players on Chess.com who keep playing but stop improving, and
  can't tell why from a single game review.
- **What I'm building next:** the connector, the coaching skill, and the loop back into
  Postgame (steps 1–3 below). Steps 4–5 come after.
- **What it won't do:** help during a game in progress (finished games only, in line with
  Chess.com's fair-play rules), run servers or accounts, or collect anyone's data. It's
  built for analysing **your own** public games.
- **Why:** I want the coach I couldn't find. It's free, open source (MIT), and a personal
  project I own and build myself.

## Where this comes from

I already coach myself this way, with an AI agent workflow I put together. It pulled every
game from my Chess.com accounts (about 7,600 games), ran each one through Stockfish, and
looked for patterns. Generic game review never showed me the result: **my opening knowledge runs
out after about three moves.** My rate of serious errors climbs from 0.4% on move 3 to
7.5% by move 8 and 19% by move 19, and the curve is the same in blitz and rapid. So the
problem is missing knowledge, not playing too fast. The usual suspects (bad openings,
tilt, time of day, weak tactics) all tested as noise.

That process works, but it's manual and only I can run it. Postgame Coach packages it so
any player can.

## What exists today ✅

- **Game review:** Chess.com games load automatically. Stockfish (WebAssembly, in a Web
  Worker) rates every move, with accuracy, Great/Best/Mistake/Blunder/Missed-win badges,
  an eval graph and a best-line explorer. Everything runs in the browser.
- **Train (shipped Nov 21, 2026):** a *coach pack* is a JSON file of positions from your
  own games where you keep picking the wrong move. Postgame drills them on a spaced
  schedule (1, 3, 7, 16, 35 days). The format is in `src/training/pack.ts`. Today the
  pack comes out of that analysis with manual steps; automating it is the core of this
  roadmap.
- **170 passing unit tests** (Vitest + Testing Library) covering analysis, accuracy,
  classification, the training scheduler and the pack parser.

## The plan

### 1. Postgame Coach connector (MCP server)
A small local MCP server that gives Claude chess tools backed by a native Stockfish:

| Tool | What it does |
|---|---|
| `get_games` | Fetch a player's public games from Chess.com for a date range |
| `analyze_games` | Run Stockfish over every move, cache results locally |
| `find_patterns` | Error rate by move number, opening, structure and piece; recurring wrong moves in the same positions |
| `explain_position` | Engine lines and evals for a position, so Claude's explanation rests on real numbers |
| `build_coach_pack` | Write the drills as a coach pack that Postgame's Train section opens |

**Ground rule:** Stockfish decides what's good, and Claude explains it. Every claim the
coach makes has to cite an engine evaluation or a count from the player's own games.

### 2. The coaching skill (the process)
A Claude Code skill that runs the diagnosis I do by hand: fetch → analyze → find the real
weakness → explain it → build drills → open them in Postgame.

- **Talk in the player's language.** Many club players don't think in square names. I
  don't. Explanations point at the board (links that open the exact position in Postgame)
  instead of strings of notation.
- **One finding at a time.** Lead with the biggest real weakness, not a list of twenty.

### 3. Close the loop in the app
- Open a coach pack from the skill in one step.
- **Progress view:** re-run the diagnosis each month and show the error curve before and
  after.
- Retire a drill once you play the right move in real games. The pack format already
  tracks this in `realGames`.

### 4. Ask about a game (later, optional)
An "Ask Claude about this move" button inside the review screen, for players who connect
Claude.

### 5. Make it easy to install
One-line install in Claude Code (also usable from Codex, Cursor and other MCP clients),
a short demo GIF, and a README that leads with the result.

## Pitfalls already found (and the checks that catch them)

These produced false findings in my own analysis before I caught them. The coach checks
for all three automatically:

1. **Ratings are reported after each game.** Naive "strength of opponent" analysis makes
   every win look like a win over a weaker player. Fix: rebuild pre-game ratings from the
   previous game.
2. **Centipawn loss exaggerates mistakes in positions that are already won.** Fix: measure
   errors in win probability. My apparent "collapses when winning" problem vanished once I
   did; the real weak spot was unbalanced positions.
3. **Most "this opening is bad for you" findings are noise.** Fix: confidence intervals
   (Wilson) before telling a player anything, and a minimum sample size.

Each detector gets fixture-based unit tests, and the diagnosis is checked against held-out
games before it's trusted.

## Privacy

Only public games. Analysis runs on your own machine: no server, no account, no stored
data on our side.

## Milestones

- [ ] **M1:** MCP server with `get_games` + `analyze_games` (native Stockfish, local cache), tested
- [ ] **M2:** pattern detectors with the three statistical checks above
- [ ] **M3:** coaching skill + automatic coach-pack export
- [ ] **M4:** progress view and drill retirement in Postgame
- [ ] **M5:** one-line install, demo, docs

Built the same way as the rest of Postgame: spec and plan first, implementation by AI
coding agents against that plan, and every change reviewed and tested before it ships.
