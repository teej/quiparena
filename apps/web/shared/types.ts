import type {
  Game,
  GameEvent,
  Matchup,
  PlayerRef,
  RoundNumber,
  Thriplash,
  VotePopulation,
  StreamEvent,
} from "@quiparena/core";

export type PlayerActivity =
  | "waiting"
  | "thinking"
  | "drafting"
  | "submitted"
  | "voting"
  | "voted"
  | "done"
  | "error";

export interface PlayerVoteState {
  prompt: string;
  options: string[];
  choice: number | null;
}

export interface LivePlayerState {
  player: PlayerRef;
  lab: string;
  avatarColor: string;
  activity: PlayerActivity;
  prompt: string | null;
  reasoning: string;
  reasoningVisible: boolean | null;
  attempts: NonNullable<Extract<StreamEvent, { type: "trace.completed" }>["attempts"]>;
  draft: string | null;
  answer: string | [string, string, string] | null;
  vote: PlayerVoteState | null;
}

export interface AnswerTrace {
  playerId: string;
  prompt: string;
  reasoning: string;
  reasoningVisible?: boolean;
  answer: string;
  usage?: Extract<StreamEvent, { type: "trace.completed" }>["usage"];
  attempts?: Extract<StreamEvent, { type: "trace.completed" }>["attempts"];
  at: string;
}

export interface LiveVoteState {
  round: RoundNumber;
  prompt: string;
  options: string[];
  votes: Record<string, number>;
  resolved: Matchup | null;
}

export type LivePhase = "waiting" | "playing" | "voting" | "ended" | "error";

export interface LiveState {
  gameId: string | null;
  roomCode: string | null;
  audienceEnabled: boolean | null;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string | null;
  round: RoundNumber | null;
  phase: LivePhase;
  playerOrder: string[];
  players: Record<string, LivePlayerState>;
  currentVote: LiveVoteState | null;
  matchups: Matchup[];
  thriplash: Thriplash | null;
  finalScores: Record<string, number> | null;
  observedScores: Record<string, number> | null;
  observedPlacements: Record<string, number> | null;
  traces: Record<string, AnswerTrace[]>;
  error: string | null;
}

export interface GameSummary {
  id: string;
  roomCode: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "completed" | "abandoned";
  playerCount: number;
  matchupCount: number;
  winner: PlayerRef | null;
  topScore: number | null;
  totalCostUsd: number;
}

export interface ArchivedGame {
  game: Game;
  events: GameEvent[];
  traces: Record<string, AnswerTrace[]>;
}

export type LeaderboardPopulation = VotePopulation | "blended";

export interface LeaderboardEntry {
  modelId: string;
  name: string;
  lab: string;
  benched: boolean;
  benchReason: string | null;
  rating: number;
  intervalLow: number;
  intervalHigh: number;
  games: number;
  wins: number;
  matchupWins: number;
  matchupLosses: number;
  matchupTies: number;
  matchupsPlayed: number;
  matchupWinRate: number;
}

export type RatingView = "standard" | "cross-family" | "family-balanced";

export interface ModelHistory {
  model: { slug: string; name: string; lab: string };
  offset: number;
  hasMore: boolean;
  answers: Array<{ id: string; gameId: string; startedAt: string; round: number; prompt: string; text: string; blank: boolean }>;
}

export interface LeaderboardResponse {
  view?: RatingView;
  seasonStartedAt?: string | null;
  population: LeaderboardPopulation;
  audienceVotingAvailable: boolean;
  audienceVotesInferred: boolean;
  entries: LeaderboardEntry[];
}
