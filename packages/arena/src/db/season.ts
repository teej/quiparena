import { eq, gte } from "drizzle-orm";
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
  return new Set(rows.map(r => r.id));
}
