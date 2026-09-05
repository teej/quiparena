import { expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { arenaSettings, games } from "../src/db/schema.js";
import { currentSeasonGameIds } from "../src/db/season.js";

it("excludes invalid trials without removing their archive or other partial games", async () => {
  const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
  try {
    await db.insert(games).values(["valid", "partial", "credits-exhausted"].map(id => ({
      id, roomCode: "TEST", startedAt: new Date("2026-09-05T00:00:00Z"),
      status: id === "valid" ? "completed" as const : "abandoned" as const,
    })));
    await db.insert(arenaSettings).values({ key: "scoring-excluded-game:credits-exhausted", value: "Provider credits exhausted" });
    expect([...(await currentSeasonGameIds(db))].sort()).toEqual(["partial", "valid"]);
    expect(await db.select().from(games)).toHaveLength(3);
  } finally { await db.close(); }
});
