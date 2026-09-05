import type { GameEvent, PlayerRef, StreamEvent } from "@quiparena/core";
import { and, asc, count, desc, eq, gte, sum } from "drizzle-orm";

import { scoringSeason } from "./season.js";
import type { ArenaDatabaseClient } from "./client.js";
import { events, gamePlayers, games, matchups, traces, votes } from "./schema.js";

export interface RecordedGameSummary {
  id: string;
  roomCode: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "completed" | "abandoned";
  playerCount: number;
  matchupCount: number;
  winner: PlayerRef | null;
  topScore: number | null;
  totalCostUsd: number;
}

export interface RecordedTrace {
  playerId: string;
  purpose?: "answer" | "vote" | "thriplash";
  prompt: string;
  reasoning: string;
  reasoningVisible?: boolean;
  answer: string;
  usage?: Extract<StreamEvent, { type: "trace.completed" }>["usage"];
  attempts?: Extract<StreamEvent, { type: "trace.completed" }>["attempts"];
  budgetMiss?: boolean;
  at: string;
}

function publicStatus(status: "created" | "running" | "completed" | "failed" | "abandoned"):
  RecordedGameSummary["status"] {
  if (status === "completed") return "completed";
  if (status === "created" || status === "running") return "running";
  return "abandoned";
}

/** Return archive summaries newest-first without reconstructing every full game. */
export async function listRecordedGames(db: ArenaDatabaseClient): Promise<RecordedGameSummary[]> {
  const [gameRows, playerRows, matchupCountRows, traceCostRows] = await Promise.all([
    db.select().from(games).orderBy(desc(games.startedAt), desc(games.id)),
    db.select({
      gameId: gamePlayers.gameId,
      playerId: gamePlayers.playerId,
      name: gamePlayers.name,
      modelSlug: gamePlayers.modelSlug,
      observedPlacement: gamePlayers.observedPlacement,
    }).from(gamePlayers),
    db.select({ gameId: matchups.gameId, value: count() })
      .from(matchups)
      .groupBy(matchups.gameId),
    db.select({ gameId: traces.gameId, value: sum(traces.costUsd) })
      .from(traces)
      .groupBy(traces.gameId),
  ]);

  const playersByGame = new Map<string, PlayerRef[]>();
  const observedWinners = new Map<string, PlayerRef>();
  for (const row of playerRows) {
    const players = playersByGame.get(row.gameId) ?? [];
    const player = { id: row.playerId, name: row.name, modelId: row.modelSlug };
    players.push(player);
    if (row.observedPlacement === 1) observedWinners.set(row.gameId, player);
    playersByGame.set(row.gameId, players);
  }
  const matchupCounts = new Map(matchupCountRows.map((row) => [row.gameId, row.value]));
  const traceCosts = new Map(traceCostRows.map((row) => [row.gameId, Number(row.value ?? 0)]));

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
      status: publicStatus(game.status),
      playerCount: players.length,
      matchupCount: matchupCounts.get(game.id) ?? 0,
      winner: observedWinners.get(game.id)
        ?? (top ? (players.find((player) => player.id === top[0]) ?? null) : null),
      topScore: top?.[1] ?? null,
      totalCostUsd: traceCosts.get(game.id) ?? 0,
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
    usage: traces.usage,
    createdAt: traces.createdAt,
    id: traces.id,
  }).from(traces)
    .where(eq(traces.gameId, gameId))
    .orderBy(asc(traces.createdAt), asc(traces.id));
  return rows.map((row) => {
    const stored = row.usage ?? {};
    const attempts = Array.isArray(stored["attempts"])
      ? stored["attempts"] as NonNullable<RecordedTrace["attempts"]>
      : undefined;
    const purpose = stored["purpose"] === "answer" || stored["purpose"] === "vote"
      || stored["purpose"] === "thriplash"
      ? stored["purpose"]
      : undefined;
    const budgetMiss = stored["budgetMiss"] === true;
    const reasoningVisible = typeof stored["reasoningVisible"] === "boolean"
      ? stored["reasoningVisible"]
      : undefined;
    const {
      attempts: _attempts,
      purpose: _purpose,
      budgetMiss: _budgetMiss,
      reasoningVisible: _reasoningVisible,
      ...usage
    } = stored;
    return {
      playerId: row.playerId,
      ...(purpose === undefined ? {} : { purpose }),
      prompt: row.prompt,
      reasoning: row.reasoning,
      ...(reasoningVisible === undefined ? {} : { reasoningVisible }),
      answer: row.answer,
      ...(Object.keys(usage).length === 0 ? {} : { usage: usage as NonNullable<RecordedTrace["usage"]> }),
      ...(attempts === undefined ? {} : { attempts }),
      ...(budgetMiss ? { budgetMiss: true } : {}),
      at: row.createdAt.toISOString(),
    };
  });
}

/** Whether any audience vote has been recorded. */
export async function hasAudienceVotes(db: ArenaDatabaseClient): Promise<boolean> {
  const start = await scoringSeason(db);
  const rows = await db.select({ id: votes.id })
    .from(votes).innerJoin(games, eq(votes.gameId, games.id))
    .where(and(eq(votes.population, "audience"), start ? gte(games.startedAt, new Date(start)) : undefined))
    .limit(1);
  return rows.length > 0;
}

/** Whether any recorded audience result was reconstructed from published percentages. */
export async function hasInferredAudienceVotes(db: ArenaDatabaseClient): Promise<boolean> {
  const start = await scoringSeason(db);
  const rows = await db.select({ id: votes.id })
    .from(votes).innerJoin(games, eq(votes.gameId, games.id))
    .where(and(eq(votes.population, "audience"), eq(votes.inferred, true), start ? gte(games.startedAt, new Date(start)) : undefined))
    .limit(1);
  return rows.length > 0;
}
