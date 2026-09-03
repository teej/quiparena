import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";

import type { LobbyGameHistory } from "../lobby.js";
import { finalizeGameScores } from "../recorder.js";
import { placementsFromScores } from "../scoring.js";
import type { ArenaDatabaseClient } from "./client.js";
import { gamePlayers, games } from "./schema.js";

export const STALE_GAME_AGE_MS = 30 * 60_000;

export interface AbandonStaleGamesOptions {
  now?: Date;
  maxAgeMs?: number;
}

/** Mark one game abandoned. Returns false only when the id does not exist. */
export async function abandonGame(
  db: ArenaDatabaseClient,
  gameId: string,
): Promise<boolean> {
  const updated = await db.update(games).set({ status: "abandoned" })
    .where(eq(games.id, gameId))
    .returning({ id: games.id });
  return updated.length > 0;
}

/** Abandon games whose last durable start time is older than the watchdog window. */
export async function abandonStaleGames(
  db: ArenaDatabaseClient,
  options: AbandonStaleGamesOptions = {},
): Promise<string[]> {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? STALE_GAME_AGE_MS;
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid stale-game timestamp");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new RangeError("maxAgeMs must be a non-negative number");
  }
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const updated = await db.update(games).set({ status: "abandoned" })
    .where(and(eq(games.status, "running"), lte(games.startedAt, cutoff)))
    .returning({ id: games.id });
  return updated.map((game) => game.id);
}

/** Fill scores missing from completed pre-scoring archives using their resolved vote rows. */
export async function backfillCompletedGameScores(
  db: ArenaDatabaseClient,
): Promise<string[]> {
  const missing = await db.select({ id: games.id }).from(games)
    .where(and(eq(games.status, "completed"), isNull(games.finalScores)))
    .orderBy(asc(games.startedAt), asc(games.id));
  const backfilled: string[] = [];
  for (const game of missing) {
    const playerRows = await db.select({
      playerId: gamePlayers.playerId,
      placement: gamePlayers.placement,
      totalScore: gamePlayers.totalScore,
    }).from(gamePlayers)
      .where(eq(gamePlayers.gameId, game.id))
      .orderBy(asc(gamePlayers.seat));
    if (playerRows.length > 0 && playerRows.every((player) => player.totalScore !== null)) {
      const finalScores: Record<string, number> = Object.fromEntries(
        playerRows.map((player) => [player.playerId, player.totalScore!]),
      );
      const placements = placementsFromScores(finalScores, playerRows.map((player) => player.playerId));
      await db.update(games).set({ finalScores }).where(eq(games.id, game.id));
      for (const player of playerRows) {
        if (player.placement !== null) continue;
        await db.update(gamePlayers).set({ placement: placements[player.playerId] ?? null })
          .where(and(eq(gamePlayers.gameId, game.id), eq(gamePlayers.playerId, player.playerId)));
      }
      backfilled.push(game.id);
    } else if (await finalizeGameScores(db, game.id)) {
      backfilled.push(game.id);
    }
  }
  return backfilled;
}

/** Completed DB history in chronological order, ready for lobby rotation. */
export async function loadLobbyHistoryFromDb(
  db: ArenaDatabaseClient,
): Promise<LobbyGameHistory[]> {
  const gameRows = await db.select({
    id: games.id,
    finalScores: games.finalScores,
  }).from(games)
    .where(eq(games.status, "completed"))
    .orderBy(asc(games.startedAt), asc(games.id));
  if (gameRows.length === 0) return [];

  const playerRows = await db.select().from(gamePlayers)
    .where(inArray(gamePlayers.gameId, gameRows.map((game) => game.id)))
    .orderBy(asc(gamePlayers.gameId), asc(gamePlayers.seat));
  return gameRows.map((game) => ({
    id: game.id,
    status: "completed",
    players: playerRows.filter((player) => player.gameId === game.id).map((player) => ({
      id: player.playerId,
      playerId: player.playerId,
      modelId: player.modelSlug,
      modelSlug: player.modelSlug,
      ...(player.placement === null ? {} : { placement: player.placement }),
      ...(player.totalScore === null ? {} : { totalScore: player.totalScore }),
    })),
    ...(game.finalScores === null ? {} : { finalScores: game.finalScores }),
  }));
}
