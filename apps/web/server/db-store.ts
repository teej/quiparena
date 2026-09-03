import type { GameEvent, StreamEvent } from "@quiparena/core";
import {
  computeRatings,
  hasAudienceVotes,
  leaderboard as loadLeaderboard,
  listRecordedGames,
  loadGame,
  loadRecordedEvents,
  loadRecordedTraces,
  Recorder,
  type ArenaDatabaseClient,
  type ComputeRatingsOptions,
  type RatingRun,
} from "@quiparena/arena";

import type {
  ArchivedGame,
  LeaderboardEntry,
  LeaderboardPopulation,
  LeaderboardResponse,
  LiveState,
} from "../shared/types.js";
import { liveStateToGame, replayEvents } from "../shared/reducer.js";
import type { Store } from "./store.js";

export interface DbStoreOptions {
  ratingsDebounceMs?: number;
  computeRatingsOptions?: ComputeRatingsOptions;
  onRatingsError?: (error: unknown) => void;
}

type TraceEvent = Extract<StreamEvent, { type: "trace.completed" }>;

/** Web persistence backed by arena's normalized database and recorder. */
export class DbStore implements Store {
  private readonly recorder: Recorder;
  private readonly ratingsDebounceMs: number;
  private readonly computeRatingsOptions: ComputeRatingsOptions;
  private readonly onRatingsError: (error: unknown) => void;
  private readonly savedTraceVersions = new Map<string, string>();
  private ratingsTimer: ReturnType<typeof setTimeout> | null = null;
  private ratingsTail: Promise<void> = Promise.resolve();

  constructor(readonly db: ArenaDatabaseClient, options: DbStoreOptions = {}) {
    const debounceMs = options.ratingsDebounceMs ?? 250;
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new RangeError("ratingsDebounceMs must be a non-negative number");
    }
    this.recorder = new Recorder(db);
    this.ratingsDebounceMs = debounceMs;
    this.computeRatingsOptions = options.computeRatingsOptions ?? {};
    this.onRatingsError = options.onRatingsError ?? ((error) => {
      console.error("Ratings refresh failed", error);
    });
  }

  async saveEvent(event: GameEvent, traceSnapshot?: LiveState["traces"]): Promise<void> {
    await this.recorder.record(event);
    if (event.gameId && traceSnapshot) await this.saveTraceSnapshot(event.gameId, traceSnapshot);
    if (event.type === "game.ended") this.scheduleRatingsRefresh();
  }

  async listGames() {
    return listRecordedGames(this.db);
  }

  async getGame(id: string): Promise<ArchivedGame | null> {
    const [game, events, recordedTraces] = await Promise.all([
      loadGame(this.db, id),
      loadRecordedEvents(this.db, id),
      loadRecordedTraces(this.db, id),
    ]);
    if (!game) return null;
    const replayedGame = liveStateToGame(replayEvents(events)) ?? game;

    const traces: ArchivedGame["traces"] = {};
    for (const trace of recordedTraces) {
      // LiveState retains the newest trace for a player/prompt pair. Applying the
      // same rule here keeps archive replay identical after intermediate snapshots.
      const existing = traces[trace.playerId] ?? [];
      traces[trace.playerId] = [
        ...existing.filter((item) => item.prompt !== trace.prompt),
        trace,
      ];
    }
    return { game: replayedGame, events, traces };
  }

  async leaderboard(population: LeaderboardPopulation): Promise<LeaderboardResponse> {
    const [rows, audienceVotingAvailable] = await Promise.all([
      loadLeaderboard(this.db, population),
      hasAudienceVotes(this.db),
    ]);
    const entries = population === "audience" && !audienceVotingAvailable
      ? []
      : rows.map((row): LeaderboardEntry => {
          const matchupWinRate = row.stats.matchupWinRate ?? 0;
          return {
            modelId: row.modelSlug,
            name: row.displayName,
            lab: row.lab,
            rating: Math.round(row.rating),
            intervalLow: Math.round(row.lower95),
            intervalHigh: Math.round(row.upper95),
            games: row.stats.games,
            wins: row.stats.wins,
            matchupWins: matchupWinRate * row.comparisons,
            matchups: row.comparisons,
            matchupWinRate,
          };
        });
    return { population, audienceVotingAvailable, entries };
  }

  /** Force a ratings snapshot now. Calls are serialized with background refreshes. */
  recomputeRatings(): Promise<RatingRun> {
    if (this.ratingsTimer) {
      clearTimeout(this.ratingsTimer);
      this.ratingsTimer = null;
    }
    const run = this.ratingsTail.then(() => computeRatings(this.db, this.computeRatingsOptions));
    this.ratingsTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Cancel a pending debounce and wait for any active ratings write. */
  async close(): Promise<void> {
    if (this.ratingsTimer) {
      clearTimeout(this.ratingsTimer);
      this.ratingsTimer = null;
    }
    await this.ratingsTail;
  }

  private async saveTraceSnapshot(gameId: string, snapshot: LiveState["traces"]): Promise<void> {
    for (const trace of Object.values(snapshot).flat()) {
      const key = `${gameId}\u0000${trace.playerId}\u0000${trace.prompt}`;
      if (this.savedTraceVersions.get(key) === trace.at) continue;
      const event: TraceEvent = {
        type: "trace.completed",
        gameId,
        playerId: trace.playerId,
        prompt: trace.prompt,
        reasoning: trace.reasoning,
        answer: trace.answer,
        at: trace.at,
      };
      await this.recorder.record(event);
      this.savedTraceVersions.set(key, trace.at);
    }
  }

  private scheduleRatingsRefresh(): void {
    if (this.ratingsTimer) clearTimeout(this.ratingsTimer);
    this.ratingsTimer = setTimeout(() => {
      this.ratingsTimer = null;
      void this.recomputeRatings().catch(this.onRatingsError);
    }, this.ratingsDebounceMs);
    this.ratingsTimer.unref?.();
  }
}
