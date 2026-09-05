import { asc, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openDb } from "../src/db/client.js";
import { Recorder } from "../src/recorder.js";
import {
  abandonGame,
  abandonStaleGames,
  backfillCompletedGameScores,
  clearModelBenchState,
  loadLobbyHistoryFromDb,
  loadModelBenchStates,
  persistModelBenchStates,
  syncRosterModels,
} from "../src/db/operations.js";
import { answers, gamePlayers, games, matchups, models, votes } from "../src/db/schema.js";

describe("database schema and migrations", () => {
  it("applies the generated Postgres migration to in-memory PGlite", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    try {
      const result = await db.execute<{ table_name: string }>(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
        order by table_name
      `);
      expect(result.rows.map((row) => row.table_name)).toEqual([
        "answers",
        "arena_settings",
        "events",
        "game_players",
        "games",
        "matchups",
        "models",
        "rating_snapshots",
        "thriplashes",
        "traces",
        "votes",
      ]);

      await db.insert(games).values({
        id: "schema-game",
        roomCode: "ABCD",
        startedAt: new Date("2026-09-02T10:00:00Z"),
      });
      await db.insert(matchups).values({
        id: "schema-matchup",
        gameId: "schema-game",
        round: 1,
        index: 0,
        prompt: "A prompt",
      });
      await db.insert(answers).values([
        {
          id: "schema-answer-0",
          gameId: "schema-game",
          matchupId: "schema-matchup",
          playerId: "human-1",
          answerIndex: 0,
          text: "Human answer",
        },
        {
          id: "schema-answer-1",
          gameId: "schema-game",
          matchupId: "schema-matchup",
          playerId: "model-1",
          answerIndex: 1,
          text: "Model answer",
        },
      ]);
      await db.insert(votes).values({
        id: "audience-vote",
        gameId: "schema-game",
        matchupId: "schema-matchup",
        voterId: null,
        population: "audience",
        source: "twitch",
        choice: 0,
        weight: 37.5,
      });
      const [stored] = await db.select().from(votes);
      expect(stored).toMatchObject({
        voterId: null,
        population: "audience",
        source: "twitch",
        weight: 37.5,
        inferred: false,
      });
      await db.update(games).set({ observedScores: [{ name: "Model", score: 123 }] });
      expect((await db.select().from(games))[0]?.observedScores).toEqual([
        { name: "Model", score: 123 },
      ]);
    } finally {
      await db.close();
    }
  });

  it("persists and clears automatic bench state without changing manual enabled state", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    try {
      const roster = [{
        slug: "test/slow",
        displayName: "Slow",
        lab: "Test",
        released: "2026-09-02",
        reasoning: null,
        temperature: null,
        enabled: false,
        disabledReason: "manual operator choice",
        rationale: "test",
      }];
      await syncRosterModels(db, roster);
      await persistModelBenchStates(db, ["test/slow"], new Map([["test/slow", {
        benched: true,
        gamesRemaining: 10,
        consecutiveSlowGames: 0,
        reason: "3 budget misses",
      }]]));

      expect((await loadModelBenchStates(db)).get("test/slow")).toMatchObject({
        benched: true,
        gamesRemaining: 10,
      });
      expect((await db.select().from(models))[0]?.enabled).toBe(false);
      await expect(clearModelBenchState(db, "test/slow")).resolves.toBe(true);
      expect((await loadModelBenchStates(db)).has("test/slow")).toBe(false);
      expect((await db.select().from(models))[0]?.enabled).toBe(false);

      await new Recorder(db).record({
        type: "game.ended",
        gameId: "ingested-bench",
        benchStates: {
          "test/slow": {
            benched: true,
            gamesRemaining: 9,
            consecutiveSlowGames: 0,
            reason: "ingested runtime bench",
          },
        },
        budget: { "test/slow": { misses: 3, answerLatenciesMs: [15_010] } },
        at: "2026-09-02T12:00:00Z",
      });
      expect((await loadModelBenchStates(db)).get("test/slow")).toMatchObject({
        benched: true,
        gamesRemaining: 9,
        reason: "ingested runtime bench",
      });
      expect((await loadLobbyHistoryFromDb(db)).find((game) => game.id === "ingested-bench")?.budget)
        .toEqual({ "test/slow": { misses: 3, answerLatenciesMs: [15_010] } });
    } finally {
      await db.close();
    }
  });

  it("auto-abandons only running games older than 30 minutes and supports manual abandon", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    try {
      const now = new Date("2026-09-02T12:00:00Z");
      await db.insert(games).values([
        { id: "stale", roomCode: "OLD1", startedAt: new Date("2026-09-02T11:29:59Z"), status: "running" },
        { id: "fresh", roomCode: "NEW1", startedAt: new Date("2026-09-02T11:30:01Z"), status: "running" },
        { id: "done", roomCode: "DONE", startedAt: new Date("2026-09-02T10:00:00Z"), status: "completed" },
      ]);

      await expect(abandonStaleGames(db, { now })).resolves.toEqual(["stale"]);
      await expect(abandonGame(db, "fresh")).resolves.toBe(true);
      await expect(abandonGame(db, "missing")).resolves.toBe(false);
      const statuses = Object.fromEntries((await db.select().from(games)).map((game) => [game.id, game.status]));
      expect(statuses).toEqual({ stale: "abandoned", fresh: "abandoned", done: "completed" });
    } finally {
      await db.close();
    }
  });

  it("abandons a running game when a later game.created reaches the same recorder", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    try {
      const recorder = new Recorder(db);
      await recorder.record({ type: "game.created", gameId: "first", roomCode: "OLD1", at: "2026-09-02T11:58:00Z" });
      await recorder.record({ type: "game.started", gameId: "first", at: "2026-09-02T11:59:00Z" });
      await recorder.record({ type: "game.created", gameId: "second", roomCode: "NEW1", at: "2026-09-02T12:00:00Z" });

      await expect(abandonStaleGames(db, {
        now: new Date("2026-09-02T12:01:00Z"),
        maxAgeMs: 60 * 60_000,
      })).resolves.toEqual(["first"]);
      expect((await db.select().from(games)).find((game) => game.id === "first")?.status)
        .toBe("abandoned");
    } finally {
      await db.close();
    }
  });

  it("backfills completed pre-scoring archives from their resolved vote rows", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    try {
      await db.insert(games).values({
        id: "legacy-complete",
        roomCode: "OLD2",
        startedAt: new Date("2026-09-02T10:00:00Z"),
        endedAt: new Date("2026-09-02T10:20:00Z"),
        status: "completed",
      });
      await db.insert(gamePlayers).values([
        { gameId: "legacy-complete", playerId: "p1", name: "One", seat: 0 },
        { gameId: "legacy-complete", playerId: "p2", name: "Two", seat: 1 },
      ]);
      await db.insert(matchups).values({
        id: "legacy-matchup",
        gameId: "legacy-complete",
        round: 1,
        index: 0,
        prompt: "Legacy prompt",
      });
      await db.insert(answers).values([
        { id: "legacy-a1", gameId: "legacy-complete", matchupId: "legacy-matchup", playerId: "p1", answerIndex: 0, text: "One" },
        { id: "legacy-a2", gameId: "legacy-complete", matchupId: "legacy-matchup", playerId: "p2", answerIndex: 1, text: "Two" },
      ]);
      await db.insert(votes).values([
        { id: "legacy-v1", gameId: "legacy-complete", matchupId: "legacy-matchup", population: "player", source: "model", choice: 0 },
        { id: "legacy-v2", gameId: "legacy-complete", matchupId: "legacy-matchup", population: "player", source: "model", choice: 0 },
      ]);

      await expect(backfillCompletedGameScores(db)).resolves.toEqual(["legacy-complete"]);
      expect((await db.select().from(games))[0]?.finalScores).toEqual({ p1: 1_250, p2: 0 });
      expect(await db.select({ playerId: gamePlayers.playerId, placement: gamePlayers.placement, totalScore: gamePlayers.totalScore })
        .from(gamePlayers).orderBy(asc(gamePlayers.seat))).toEqual([
        { playerId: "p1", placement: 1, totalScore: 1_250 },
        { playerId: "p2", placement: 2, totalScore: 0 },
      ]);
      await expect(backfillCompletedGameScores(db)).resolves.toEqual([]);
    } finally {
      await db.close();
    }
  });
});
