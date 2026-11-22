import type { GameSummary, TimeClass } from '../../../src/types';

export interface CoachGame extends GameSummary {
  /** Which of the usernames this game belongs to. */
  username: string;
  /** Raw Chess.com time control, e.g. "180+2" (daily: "1/259200"). */
  timeControl: string;
  /** Starting clock and increment in seconds; 0 for daily games, which have no meaningful clock. */
  baseSec: number;
  incSec: number;
  /** Previous game's post-game rating, same username + time class; null for the first game seen. */
  myPreRating: number | null;
  /** Seconds left after each ply (index = ply); null where the PGN has no %clk. */
  clocks: (number | null)[];
}

export interface GameSource {
  fetchGames(
    usernames: string[],
    opts: { timeClass: TimeClass; maxGames: number; before?: number },
  ): Promise<CoachGame[]>;
}
