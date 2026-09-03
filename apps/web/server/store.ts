import type { GameEvent, Matchup, PlayerRef, Vote } from "@quiparena/core";

import { createEmptyLiveState, labForModel, liveStateToGame, reduceLiveState } from "../shared/reducer.js";
import type {
  ArchivedGame,
  GameSummary,
  LeaderboardEntry,
  LeaderboardPopulation,
  LeaderboardResponse,
  LiveState,
} from "../shared/types.js";
import { createDemoFixture } from "./demo.js";
import type { FrontierResponse } from "../shared/frontier.js";
import { inMemoryFrontier } from "./frontier.js";

/**
 * Persistence boundary for the web process. The arena worker never writes the
 * database directly: it sends durable GameEvents here, and a future database
 * adapter only needs to implement these four read/write operations. The trace
 * snapshot accompanying a durable event lets archives retain answer reasoning
 * without turning every streamed token into a database write.
 */
export interface Store {
  saveEvent(event: GameEvent, traces?: LiveState["traces"]): Promise<void>;
  listGames(): Promise<GameSummary[]>;
  getGame(id: string): Promise<ArchivedGame | null>;
  leaderboard(population: LeaderboardPopulation): Promise<LeaderboardResponse>;
  frontier(population: LeaderboardPopulation): Promise<FrontierResponse>;
  loadLiveState?(): Promise<LiveState>;
}

interface StoredRecord {
  state: LiveState;
  events: GameEvent[];
  traces: ArchivedGame["traces"];
}

export class InMemoryStore implements Store {
  private readonly records = new Map<string, StoredRecord>();

  constructor(seedDemo = true) {
    if (seedDemo) {
      const fixture = createDemoFixture();
      const state = fixture.archive.events.reduce(reduceLiveState, createEmptyLiveState());
      this.records.set(fixture.archive.game.id, {
        state,
        events: structuredClone(fixture.archive.events),
        traces: structuredClone(fixture.archive.traces),
      });
    }
  }

  async saveEvent(event: GameEvent, traces?: LiveState["traces"]): Promise<void> {
    const gameId = event.gameId;
    if (!gameId) return;
    let record = this.records.get(gameId);
    if (!record || event.type === "game.created") {
      record = { state: createEmptyLiveState(), events: [], traces: {} };
      this.records.set(gameId, record);
    }
    record.events.push(structuredClone(event));
    record.state = reduceLiveState(record.state, event);
    if (traces) record.traces = structuredClone(traces);
  }

  async listGames(): Promise<GameSummary[]> {
    return [...this.records.values()]
      .map((record) => liveStateToGame(record.state))
      .filter((game): game is NonNullable<typeof game> => Boolean(game))
      .map(toSummary)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async getGame(id: string): Promise<ArchivedGame | null> {
    const record = this.records.get(id);
    if (!record) return null;
    const game = liveStateToGame(record.state);
    if (!game) return null;
    return structuredClone({ game, events: record.events, traces: record.traces });
  }

  async leaderboard(population: LeaderboardPopulation): Promise<LeaderboardResponse> {
    if (population === "audience") {
      return { population, audienceVotingAvailable: false, entries: [] };
    }
    const games = [...this.records.values()]
      .map((record) => liveStateToGame(record.state))
      .filter((game): game is NonNullable<typeof game> => Boolean(game));
    return {
      population,
      audienceVotingAvailable: false,
      entries: calculateLeaderboard(games.flatMap((game) => game.players), games, population),
    };
  }

  async frontier(population: LeaderboardPopulation): Promise<FrontierResponse> {
    const board = await this.leaderboard(population);
    const records = [...this.records.values()];
    const games = records.map((record) => liveStateToGame(record.state));
    const kept = games.flatMap((game, index) => (game ? [{ game, traces: records[index]?.traces ?? {} }] : []));
    return {
      population,
      audienceVotingAvailable: board.audienceVotingAvailable,
      entries: inMemoryFrontier(population, board.entries, kept.map((item) => item.game), kept.map((item) => item.traces)),
    };
  }
}

function toSummary(game: NonNullable<ReturnType<typeof liveStateToGame>>): GameSummary {
  const scores = Object.entries(game.observedScores ?? game.finalScores ?? {})
    .sort((left, right) => right[1] - left[1]);
  const [top] = scores;
  const winner = top ? (game.players.find((player) => player.id === top[0]) ?? null) : null;
  return {
    id: game.id,
    roomCode: game.roomCode,
    startedAt: game.startedAt,
    endedAt: game.endedAt ?? null,
    status: game.endedAt ? "completed" : "running",
    playerCount: game.players.length,
    matchupCount: game.matchups.length,
    winner,
    topScore: top?.[1] ?? null,
  };
}

interface MutableRating {
  player: PlayerRef;
  rating: number;
  games: number;
  wins: number;
  matchupWins: number;
  matchupLosses: number;
  matchupTies: number;
  matchupsPlayed: number;
}

function selectedVotes(matchup: Matchup, population: LeaderboardPopulation): Vote[] {
  if (population === "blended") return matchup.votes;
  return matchup.votes.filter((vote) => vote.population === population);
}

function voteWeight(vote: Vote): number {
  return vote.weight ?? 1;
}

function calculateLeaderboard(
  allPlayers: PlayerRef[],
  games: Array<{
    players: PlayerRef[];
    matchups: Matchup[];
    finalScores?: Record<string, number>;
    observedScores?: Record<string, number>;
  }>,
  population: LeaderboardPopulation,
): LeaderboardEntry[] {
  const ratings = new Map<string, MutableRating>();
  for (const player of allPlayers) {
    if (!player.modelId || ratings.has(player.modelId)) continue;
    ratings.set(player.modelId, {
      player,
      rating: 1500,
      games: 0,
      wins: 0,
      matchupWins: 0,
      matchupLosses: 0,
      matchupTies: 0,
      matchupsPlayed: 0,
    });
  }

  for (const game of games) {
    const rankingScores = game.observedScores ?? game.finalScores ?? {};
    const topScore = Math.max(...Object.values(rankingScores), Number.NEGATIVE_INFINITY);
    for (const player of game.players) {
      if (!player.modelId) continue;
      const rating = ratings.get(player.modelId);
      if (!rating) continue;
      rating.games += 1;
      if (rankingScores[player.id] === topScore) rating.wins += 1;
    }

    for (const matchup of game.matchups) {
      const leftPlayer = game.players.find((player) => player.id === matchup.answers[0].playerId);
      const rightPlayer = game.players.find((player) => player.id === matchup.answers[1].playerId);
      if (!leftPlayer?.modelId || !rightPlayer?.modelId) continue;
      const left = ratings.get(leftPlayer.modelId);
      const right = ratings.get(rightPlayer.modelId);
      if (!left || !right) continue;
      const votes = selectedVotes(matchup, population);
      if (votes.length === 0) continue;
      const leftVotes = votes.filter((vote) => vote.choice === 0).reduce((sum, vote) => sum + voteWeight(vote), 0);
      const rightVotes = votes.filter((vote) => vote.choice === 1).reduce((sum, vote) => sum + voteWeight(vote), 0);
      const total = leftVotes + rightVotes;
      if (total === 0) continue;
      const actualLeft = leftVotes / total;
      const expectedLeft = 1 / (1 + 10 ** ((right.rating - left.rating) / 400));
      const delta = 28 * (actualLeft - expectedLeft);
      left.rating += delta;
      right.rating -= delta;
      left.matchupsPlayed += 1;
      right.matchupsPlayed += 1;
      if (leftVotes > rightVotes) {
        left.matchupWins += 1;
        right.matchupLosses += 1;
      } else if (rightVotes > leftVotes) {
        right.matchupWins += 1;
        left.matchupLosses += 1;
      } else {
        left.matchupTies += 1;
        right.matchupTies += 1;
      }
    }
  }

  return [...ratings.values()]
    .map((entry): LeaderboardEntry => {
      const margin = 196 / Math.sqrt(Math.max(1, entry.matchupsPlayed));
      return {
        modelId: entry.player.modelId ?? entry.player.id,
        name: entry.player.name,
        lab: labForModel(entry.player.modelId),
        rating: Math.round(entry.rating),
        intervalLow: Math.round(entry.rating - margin),
        intervalHigh: Math.round(entry.rating + margin),
        games: entry.games,
        wins: entry.wins,
        matchupWins: entry.matchupWins,
        matchupLosses: entry.matchupLosses,
        matchupTies: entry.matchupTies,
        matchupsPlayed: entry.matchupsPlayed,
        matchupWinRate: entry.matchupsPlayed === 0 ? 0 : entry.matchupWins / entry.matchupsPlayed,
      };
    })
    .sort((left, right) => right.rating - left.rating || left.name.localeCompare(right.name));
}
