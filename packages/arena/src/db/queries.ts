import type { GameEvent, PlayerRef } from "@quiparena/core";
import { asc, count, desc, eq } from "drizzle-orm";

import type { ArenaDatabaseClient } from "./client.js";
import { events, gamePlayers, games, matchups, traces, votes } from "./schema.js";

export interface RecordedGameSummary {
  id: string;
  roomCode: string;
  startedAt: string;
  endedAt: string | null;
  playerCount: number;
  matchupCount: number;
  winner: PlayerRef | null;
  topScore: number | null;
}

export interface RecordedTrace {
  playerId: string;
  prompt: string;
  reasoning: string;
  answer: string;
  at: string;
}

/** Return archive summaries newest-first without reconstructing every full game. */
export async function listRecordedGames(db: ArenaDatabaseClient): Promise<RecordedGameSummary[]> {
  const [gameRows, playerRows, matchupCountRows] = await Promise.all([
    db.select().from(games).orderBy(desc(games.startedAt), desc(games.id)),
    db.select({
      gameId: gamePlayers.gameId,
      playerId: gamePlayers.playerId,
      name: gamePlayers.name,
      modelSlug: gamePlayers.modelSlug,
    }).from(gamePlayers),
    db.select({ gameId: matchups.gameId, value: count() })
      .from(matchups)
      .groupBy(matchups.gameId),
  ]);

  const playersByGame = new Map<string, PlayerRef[]>();
  for (const row of playerRows) {
    const players = playersByGame.get(row.gameId) ?? [];
    players.push({ id: row.playerId, name: row.name, modelId: row.modelSlug });
    playersByGame.set(row.gameId, players);
  }
  const matchupCounts = new Map(matchupCountRows.map((row) => [row.gameId, row.value]));

  return gameRows.map((game) => {
    const players = playersByGame.get(game.id) ?? [];
    const observedByPlayer = new Map((game.observedScores ?? []).flatMap((standing) => {
      const player = players.find((candidate) => (
        candidate.name.normalize("NFC").trim().toLocaleLowerCase("en-US")
          === standing.name.normalize("NFC").trim().toLocaleLowerCase("en-US")
      ));
      return player ? [[player.id, standing.score] as const] : [];
    }));
    const sourceScores = observedByPlayer.size > 0
      ? { ...(game.finalScores ?? {}), ...Object.fromEntries(observedByPlayer) }
      : game.finalScores ?? {};
    const scores = Object.entries(sourceScores)
      .sort((left, right) => right[1] - left[1]);
    const top = scores[0];
    return {
      id: game.id,
      roomCode: game.roomCode,
      startedAt: game.startedAt.toISOString(),
      endedAt: game.endedAt?.toISOString() ?? null,
      playerCount: players.length,
      matchupCount: matchupCounts.get(game.id) ?? 0,
      winner: top ? (players.find((player) => player.id === top[0]) ?? null) : null,
      topScore: top?.[1] ?? null,
    };
  });
}

/** Load the immutable durable event stream in ingest order. */
export async function loadRecordedEvents(
  db: ArenaDatabaseClient,
  gameId: string,
): Promise<GameEvent[]> {
  const rows = await db.select({ payload: events.payload })
    .from(events)
    .where(eq(events.gameId, gameId))
    .orderBy(asc(events.id));
  return rows.map((row) => row.payload);
}

/** Load normalized completed traces in chronological order. */
export async function loadRecordedTraces(
  db: ArenaDatabaseClient,
  gameId: string,
): Promise<RecordedTrace[]> {
  const rows = await db.select({
    playerId: traces.playerId,
    prompt: traces.prompt,
    reasoning: traces.reasoning,
    answer: traces.answer,
    createdAt: traces.createdAt,
    id: traces.id,
  }).from(traces)
    .where(eq(traces.gameId, gameId))
    .orderBy(asc(traces.createdAt), asc(traces.id));
  return rows.map((row) => ({
    playerId: row.playerId,
    prompt: row.prompt,
    reasoning: row.reasoning,
    answer: row.answer,
    at: row.createdAt.toISOString(),
  }));
}

/** Whether any audience vote has been recorded. */
export async function hasAudienceVotes(db: ArenaDatabaseClient): Promise<boolean> {
  const rows = await db.select({ id: votes.id })
    .from(votes)
    .where(eq(votes.population, "audience"))
    .limit(1);
  return rows.length > 0;
}
