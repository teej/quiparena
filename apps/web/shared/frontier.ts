import type { LeaderboardPopulation } from "./types.js";

/**
 * One enabled model on the cost frontier. Cost is the sum of `cost_usd` over every
 * trace the model produced (answers, finals, and votes); a "winning joke" is a
 * rounds 1-2 matchup the model won on a strict majority of the selected population's
 * weighted votes. Ties are played but not won.
 */
export interface FrontierEntry {
  slug: string;
  displayName: string;
  lab: string;
  rating: number;
  plusMinus: number;
  games: number;
  /** Count of answer traces (rounds 1-2 prompts). */
  answers: number;
  matchupWins: number;
  matchupsPlayed: number;
  totalCostUsd: number;
  costPerAnswerUsd: number | null;
  costPerWinUsd: number | null;
  avgAnswerMs: number | null;
  reasoningTokensPerAnswer: number | null;
}

export interface FrontierResponse {
  population: LeaderboardPopulation;
  audienceVotingAvailable: boolean;
  entries: FrontierEntry[];
}
