import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openDb } from "../src/db/client.js";
import { answers, games, matchups, votes } from "../src/db/schema.js";

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
    } finally {
      await db.close();
    }
  });
});
