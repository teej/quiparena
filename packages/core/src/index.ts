/**
 * @quiparena/core - domain types shared by the harness, the arena worker, and the web app.
 *
 * Quiplash 3 in one paragraph: 3-8 players. Rounds 1 and 2: every player gets two
 * prompts, every prompt is shared by exactly two players, and everyone who did not
 * write for a prompt votes between its two answers. Round 2 scores double. Round 3
 * ("Thriplash"): everyone answers the same prompt with three lines, everyone votes
 * for one entry (not their own). The audience (if enabled) votes in every round.
 */

export type RoundNumber = 1 | 2 | 3;

/** Who cast a vote. Models are `player`; Twitch/audience humans are `audience`. */
export type VotePopulation = "player" | "audience";

export interface PlayerRef {
  /** Stable id within a game (seat or ecast player id). */
  id: string;
  /** Display name shown in the game, 12 chars max in Quiplash 3. */
  name: string;
  /** Model slug (e.g. "openai/gpt-5.5") when the player is a model; null for humans. */
  modelId: string | null;
}

export interface Answer {
  playerId: string;
  text: string;
  /** True when the player submitted nothing before the timer (the game shows a "no answer"). */
  blank: boolean;
}

export interface Vote {
  voterId: string;
  population: VotePopulation;
  /** Index into Matchup.answers (rounds 1-2) or into ThriplashEntry list (round 3). */
  choice: number;
  /** Audience votes may arrive as an aggregate count rather than one row per human. */
  weight?: number;
}

/** A head-to-head prompt in rounds 1-2. This is the atomic unit for ratings. */
export interface Matchup {
  id: string;
  gameId: string;
  round: 1 | 2;
  /** Position of this matchup inside the round, in the order the game presented it. */
  index: number;
  prompt: string;
  answers: [Answer, Answer];
  votes: Vote[];
  /** Points awarded per player, if the harness observed them. */
  scores?: Record<string, number>;
}

export interface ThriplashEntry {
  playerId: string;
  lines: [string, string, string];
}

export interface Thriplash {
  gameId: string;
  prompt: string;
  entries: ThriplashEntry[];
  votes: Vote[];
  scores?: Record<string, number>;
}

export interface Game {
  id: string;
  roomCode: string;
  startedAt: string;
  endedAt?: string;
  players: PlayerRef[];
  matchups: Matchup[];
  thriplash?: Thriplash;
  /** Arena-computed final score by player id. */
  finalScores?: Record<string, number>;
  /** Scores read from the game's own final standings, kept beside arena-computed scores. */
  observedScores?: Record<string, number>;
  /** Audience-narrated final placement by player id, when available. */
  observedPlacements?: Record<string, number>;
}

/** A name/score row narrated by Quiplash's audience accessibility projection. */
export interface ObservedStanding {
  name: string;
  score: number;
}

/** A final name/score row, including the narrated ordinal placement. */
export interface ObservedFinalStanding extends ObservedStanding {
  placement: number;
}

/** Raw controller display values retained alongside the harness's plain-text projection. */
export interface HarnessControllerRaw {
  prompt?: unknown;
  choices?: unknown;
  doneText?: unknown;
}

export interface ModelBudgetSnapshot {
  misses: number;
  answerLatenciesMs: number[];
}

export interface ModelBenchSnapshot {
  benched: boolean;
  gamesRemaining: number;
  consecutiveSlowGames: number;
  reason?: string;
  benchedAtGameId?: string;
  updatedAtGameId?: string;
}

/**
 * Events emitted by the harness/arena. Persistent events form the game record;
 * ephemeral events stream to the website but are not stored individually.
 */
export type GameEvent =
  | { type: "game.created"; gameId: string; roomCode: string; at: string }
  | { type: "player.joined"; gameId: string; player: PlayerRef; at: string }
  | { type: "game.started"; gameId: string; at: string }
  | { type: "round.started"; gameId: string; round: RoundNumber; at: string }
  | { type: "prompt.dealt"; gameId: string; round: RoundNumber; playerId: string; prompt: string; deadlineMs: number; controller?: HarnessControllerRaw; at: string }
  | { type: "answer.rejected"; gameId: string; round: RoundNumber; playerId: string; prompt: string; answer: string | [string, string, string]; reason: string; at: string }
  | { type: "answer.submitted"; gameId: string; round: RoundNumber; playerId: string; prompt: string; answer: string | [string, string, string]; blank: boolean; latencyMs: number; budgetMiss?: boolean; controller?: HarnessControllerRaw; at: string }
  | { type: "vote.requested"; gameId: string; round: RoundNumber; playerId: string; prompt: string; options: string[]; deadlineMs: number; controller?: HarnessControllerRaw; at: string }
  | { type: "vote.cast"; gameId: string; round: RoundNumber; playerId: string; prompt: string; choice: number; choiceKey?: string | number; answer?: string; latencyMs?: number; budgetMiss?: boolean; controller?: HarnessControllerRaw; at: string }
  | { type: "matchup.resolved"; gameId: string; matchup: Matchup; at: string }
  | { type: "thriplash.resolved"; gameId: string; thriplash: Thriplash; at: string }
  | { type: "matchup.observed"; gameId: string; prompt: string; answers: [string, string]; winner: 0 | 1 | "tie"; percentages?: [number, number]; raw: unknown; at: string }
  | { type: "scoreboard.observed"; gameId: string; round: RoundNumber; standings: ObservedStanding[]; raw: unknown; at: string }
  | { type: "standings.observed"; gameId: string; standings: ObservedFinalStanding[]; winner: string; raw: unknown; at: string }
  | { type: "audience.votes"; gameId: string; prompt: string; counts: number[]; raw: unknown; at: string }
  | { type: "game.ended"; gameId: string; finalScores?: Record<string, number>; budget?: Record<string, ModelBudgetSnapshot>; benchStates?: Record<string, ModelBenchSnapshot | null>; at: string }
  | { type: "harness.error"; gameId?: string; playerId?: string; message: string; reason?: string; stateKey?: string; missedOccurrences?: number; at: string };

/** Ephemeral streaming events, for the live site only. */
export type StreamEvent =
  | { type: "thinking.delta"; gameId: string; playerId: string; text: string; at: string }
  | { type: "answer.draft"; gameId: string; playerId: string; text: string; at: string }
  | { type: "trace.completed"; gameId: string; playerId: string; purpose?: "answer" | "vote" | "thriplash"; prompt: string; reasoning: string; answer: string; budgetMiss?: boolean; attempts?: Array<{ kind: "primary" | "fast" | "corrective"; ms: number; firstTokenMs: number | null; reasoningTokens: number; aborted: boolean; text?: string; reason?: string }>; usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number; costUsd?: number; totalMs?: number; firstTokenMs?: number | null }; at: string };

export type AnyEvent = GameEvent | StreamEvent;
