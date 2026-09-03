import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { LobbyGameHistory } from "../lobby.js";
import { finalizeGameScores } from "../recorder.js";
import { placementsFromScores } from "../scoring.js";
import type { ArenaDatabaseClient } from "./client.js";
import { events, gamePlayers, games } from "./schema.js";

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

/** Abandon timed-out games and running games superseded by a later game creation. */
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
  const [running, creations] = await Promise.all([
    db.select({ id: games.id, startedAt: games.startedAt }).from(games)
      .where(eq(games.status, "running")),
    db.select({ id: events.id, gameId: events.gameId }).from(events)
      .where(eq(events.type, "game.created"))
      .orderBy(asc(events.id)),
  ]);
  const firstCreation = new Map<string, number>();
  for (const creation of creations) {
    if (creation.gameId && !firstCreation.has(creation.gameId)) {
      firstCreation.set(creation.gameId, creation.id);
    }
  }
  const staleIds = running.flatMap((game) => {
    const creationId = firstCreation.get(game.id);
    const superseded = creationId !== undefined && creations.some((creation) => (
      creation.gameId !== null && creation.gameId !== game.id && creation.id > creationId
    ));
    return game.startedAt <= cutoff || superseded ? [game.id] : [];
  });
  if (staleIds.length === 0) return [];
  const updated = await db.update(games).set({ status: "abandoned" })
    .where(and(eq(games.status, "running"), inArray(games.id, staleIds)))
    .returning({ id: games.id });
  const updatedIds = new Set(updated.map((game) => game.id));
  return staleIds.filter((id) => updatedIds.has(id));
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
    observedScores: games.observedScores,
  }).from(games)
    .where(eq(games.status, "completed"))
    .orderBy(asc(games.startedAt), asc(games.id));
  if (gameRows.length === 0) return [];

  const playerRows = await db.select().from(gamePlayers)
    .where(inArray(gamePlayers.gameId, gameRows.map((game) => game.id)))
    .orderBy(asc(gamePlayers.gameId), asc(gamePlayers.seat));
  return gameRows.map((game) => {
    const players = playerRows.filter((player) => player.gameId === game.id);
    const observedFromPlayers = Object.fromEntries(players.flatMap((player) => (
      player.observedScore === null ? [] : [[player.playerId, player.observedScore]]
    )));
    const playerByName = new Map(players.map((player) => [
      player.name.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US"),
      player.playerId,
    ]));
    const observedFromGame = Object.fromEntries((game.observedScores ?? []).flatMap((standing) => {
      const playerId = playerByName.get(
        standing.name.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US"),
      );
      return playerId ? [[playerId, standing.score]] : [];
    }));
    const observedFinalScores = { ...observedFromGame, ...observedFromPlayers };
    const finalScores = Object.keys(observedFinalScores).length > 0
      ? { ...(game.finalScores ?? {}), ...observedFinalScores }
      : game.finalScores;
    return {
      id: game.id,
      status: "completed",
      players: players.map((player) => ({
        id: player.playerId,
        playerId: player.playerId,
        modelId: player.modelSlug,
        modelSlug: player.modelSlug,
        ...((player.observedPlacement ?? player.placement) === null
          ? {}
          : { placement: player.observedPlacement ?? player.placement! }),
        ...((player.observedScore ?? player.totalScore) === null
          ? {}
          : { totalScore: player.observedScore ?? player.totalScore! }),
      })),
      ...(finalScores === null ? {} : { finalScores }),
    };
  });
}
