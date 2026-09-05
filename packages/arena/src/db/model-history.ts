import { and, desc, eq } from "drizzle-orm";
import type { ArenaDatabaseClient } from "./client.js";
import { answers, gamePlayers, games, matchups, models, thriplashes } from "./schema.js";

export async function modelHistory(db: ArenaDatabaseClient, slug: string, offset = 0, limit = 50) {
  const [model] = await db.select({ slug: models.slug, name: models.displayName, lab: models.lab })
    .from(models).where(eq(models.slug, slug));
  if (!model) return null;
  const rows = await db.select({
    id: answers.id, gameId: games.id, startedAt: games.startedAt, round: matchups.round,
    prompt: answers.prompt, matchupPrompt: matchups.prompt, finalPrompt: thriplashes.prompt,
    text: answers.text, lines: answers.lines, blank: answers.blank,
  }).from(answers)
    .innerJoin(gamePlayers, and(eq(answers.gameId, gamePlayers.gameId), eq(answers.playerId, gamePlayers.playerId)))
    .innerJoin(games, eq(games.id, answers.gameId))
    .leftJoin(matchups, eq(matchups.id, answers.matchupId))
    .leftJoin(thriplashes, eq(thriplashes.id, answers.thriplashId))
    .where(eq(gamePlayers.modelSlug, slug))
    .orderBy(desc(games.startedAt), desc(answers.id)).limit(limit + 1).offset(offset);
  return { model, offset, hasMore: rows.length > limit, answers: rows.slice(0, limit).map(row => ({
    id: row.id, gameId: row.gameId, startedAt: row.startedAt.toISOString(), round: row.round ?? 3,
    prompt: row.prompt ?? row.matchupPrompt ?? row.finalPrompt ?? "Unknown prompt",
    text: row.lines ? row.lines.join("\n") : row.text, blank: row.blank,
  })) };
}
