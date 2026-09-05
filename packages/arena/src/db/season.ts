import { eq, gte, like } from "drizzle-orm";
import type { ArenaDatabaseClient } from "./client.js";
import { arenaSettings, games, models } from "./schema.js";

export async function scoringSeason(db: ArenaDatabaseClient): Promise<string | null> {
  const [row] = await db.select().from(arenaSettings).where(eq(arenaSettings.key, "scoring-season-start"));
  return row?.value ?? null;
}

/** Starts fresh ratings while preserving every archived game, answer, and old snapshot. */
export async function resetScoringSeason(db: ArenaDatabaseClient, now = new Date()): Promise<string> {
  const startedAt = now.toISOString();
  await db.transaction(async tx => {
    await tx.insert(arenaSettings).values({ key: "scoring-season-start", value: startedAt })
      .onConflictDoUpdate({ target: arenaSettings.key, set: { value: startedAt } });
    await tx.update(models).set({ benchState: null });
  });
  return startedAt;
}

export async function currentSeasonGameIds(db: ArenaDatabaseClient): Promise<Set<string>> {
  const start = await scoringSeason(db);
  const rows = await db.select({ id: games.id }).from(games)
    .where(start ? gte(games.startedAt, new Date(start)) : undefined);
  const excluded = await db.select({ key: arenaSettings.key }).from(arenaSettings)
    .where(like(arenaSettings.key, "scoring-excluded-game:%"));
  const excludedIds = new Set(excluded.map(row => row.key.slice("scoring-excluded-game:".length)));
  return new Set(rows.filter(row => !excludedIds.has(row.id)).map(row => row.id));
}
