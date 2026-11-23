# Postgame Coach (work in progress)

Claude plus Stockfish as a personal chess coach. It runs as a local MCP server with an
in-chat widget (MCP Apps) in Claude Desktop. It analyses your public Chess.com games,
shows a report card of where your points go, and coaches you on positions from your own
games: **you try first**, and the engine's answer only appears after you've moved.

> **Status:** the analysis, the report card, the drill-down and the try-first sessions work
> end to end on real games (900 analysed blitz games in testing). Still to come: drills
> sent to the phone through Postgame's Train tab, re-checking your progress after a few
> weeks, and full install docs. See [ROADMAP.md](../ROADMAP.md).

## What it does

1. **Analyses your games.** Each move is scored with native Stockfish (fast 30 ms search)
   and cached locally, so later runs are instant.
2. **Shows where your points go, from your own games only.** The report has no comparison
   with other players.
   - **Conversion:** how often you were clearly winning (75%+ winning chances on two of
     your moves in a row), and how many of those games you lost or drew.
   - **Where your lost winning chances go:** the share given away when you were low on the
     clock, already winning, already losing, in your first 10 moves, in endgames, and in
     balanced middlegames. Each share has a likely range from resampling whole games.
   - **Losses on time,** plus one outcome-based "what if" estimate, labelled as rough.
3. **Lets you click into any number.** The headline, each bar and each quick fix open the
   actual games behind it. Each row has the date, the result, "Move 23: 82% → 30%", a
   win-chance sparkline with the slip marked, and a mini board. Buttons: **Try this
   position** and **Open on Chess.com**.
4. **Coaches try-first.** A position opens with no arrows and no hints. You make a move
   and say why. Only then is it checked with a deeper, deterministic search (depth 16,
   results stored on disk so answers never change), and you see your move next to the
   engine's. Claude coaches the thinking, not just the move. Only the first try per board
   counts.

## Honesty rules (enforced in code and tests)

- Every number shown comes from Stockfish or the stats. The tool descriptions tell the
  model never to state a move or evaluation that a tool didn't return.
- A board shown or used as a lesson is always re-checked with the deep search. Numbers
  from the fast search are labelled "quick check".
- There are no rating claims except one outcome-based estimate. It's labelled "rough
  estimate", capped, and only shown above minimum sample sizes. When there are too few
  games, the card says so instead of drawing ranges.
- Only your own public games are used. No other players' data, and no opponent names in
  the output.

## Run it locally

Requirements: Node 20+, Stockfish installed (for example `brew install stockfish`), and
Claude Desktop.

```bash
cd coach
npm install
npm run build:widgets       # builds the widget into coach/dist/board.html
npm test                    # unit tests (no engine needed)
npm run test:engine         # engine tests (needs Stockfish)
```

Add the server to Claude Desktop's `claude_desktop_config.json`. Use absolute paths:
Claude Desktop starts servers with a bare PATH.

```json
{
  "mcpServers": {
    "postgame-coach": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/postgame/coach/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/to/postgame/coach/src/server/server.ts"
      ],
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/bin:/bin",
        "STOCKFISH_PATH": "/opt/homebrew/bin/stockfish"
      }
    }
  }
}
```

Restart Claude Desktop. Then pick **Coach me** from the Postgame Coach entry in the
**+** menu and enter your Chess.com username.

Data lives in `~/.postgame-coach/` (set `POSTGAME_COACH_HOME` to move it): the analysis
cache, the stored deep checks, and a small local "student file" of what you've practised.

## Tools

| Tool | What it does |
|---|---|
| `coach_start_analysis` | Fetches and analyses your games (runs in the background) |
| `coach_report` | The report card (widget) |
| `coach_diagnosis` | The same findings as text |
| `coach_examples` | The games behind a finding (the drill-down) |
| `coach_ask_position` | Opens a position in question mode (no answer) |
| `coach_check_move` | Scores your try at depth and shows the answer |
| `coach_explain_position` | Explains a position you've already tried |
| `coach_note_thinking`, `coach_student` | The local student file |
| `coach_engine_status` | Engine and analysis status |

The `coach_me` prompt runs a whole session: report card, warm-up, guided positions,
practice, one rule of thumb, and homework.

## Layout

| Path | What lives there |
|---|---|
| `src/sources/` | Chess.com fetch, pre-game ratings, clocks |
| `src/analysis/` | The analysis runner and the cache |
| `src/engine/` | Native Stockfish adapter and the deterministic display engine |
| `src/diagnosis/` | Where your points go, conversion, examples, repeated positions, stats |
| `src/coaching/` | Lesson pools, try-first checks, the student file |
| `src/server/` | MCP server, tools, the views the widget renders |
| `widgets/` | The React widget: report card, drill-down, boards, status |

MIT licensed. Stockfish is a separate program and is never bundled.
