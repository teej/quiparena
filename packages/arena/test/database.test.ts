import { asc, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openDb } from "../src/db/client.js";
import {
  abandonGame,
  abandonStaleGames,
  backfillCompletedGameScores,
} from "../src/db/operations.js";
import { answers, gamePlayers, games, matchups, votes } from "../src/db/schema.js";

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
      });
      await db.update(games).set({ observedScores: [{ name: "Model", score: 123 }] });
      expect((await db.select().from(games))[0]?.observedScores).toEqual([
        { name: "Model", score: 123 },
      ]);
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
