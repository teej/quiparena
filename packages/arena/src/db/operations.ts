import type { StreamEvent } from "@quiparena/core";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { BudgetMissTracker } from "../budget-tracker.js";
import type {
  LobbyGameHistory,
  LobbyModelBudgetMetrics,
  ModelBenchState,
} from "../lobby.js";
import { finalizeGameScores } from "../recorder.js";
import type { RosterModel } from "../registry.js";
import { placementsFromScores } from "../scoring.js";
import type { ArenaDatabaseClient } from "./client.js";
import { events, gamePlayers, games, models, traces } from "./schema.js";

type TraceEvent = Extract<StreamEvent, { type: "trace.completed" }>;

export const STALE_GAME_AGE_MS = 30 * 60_000;

export interface AbandonStaleGamesOptions {
  now?: Date;
  maxAgeMs?: number;
}

function isModelBenchState(value: unknown): value is ModelBenchState {
  return typeof value === "object" && value !== null
    && typeof (value as ModelBenchState).benched === "boolean"
    && Number.isInteger((value as ModelBenchState).gamesRemaining)
    && Number.isInteger((value as ModelBenchState).consecutiveSlowGames);
}

function modelBudgetMetrics(value: unknown): Record<string, LobbyModelBudgetMetrics> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).flatMap(([slug, metrics]) => {
    if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) return [];
    const record = metrics as Record<string, unknown>;
    const misses = record["misses"];
    const latencies = record["answerLatenciesMs"];
    if (!Number.isInteger(misses) || (misses as number) < 0 || !Array.isArray(latencies)
      || latencies.some((latency) => typeof latency !== "number" || !Number.isFinite(latency))) {
      return [];
    }
    return [[slug, { misses: misses as number, answerLatenciesMs: latencies as number[] }] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** Keep durable model metadata current without coupling automatic benching to enabled. */
export async function syncRosterModels(
  db: ArenaDatabaseClient,
  roster: readonly RosterModel[],
): Promise<void> {
  for (const entry of roster) {
    await db.insert(models).values({
      slug: entry.slug,
      displayName: entry.displayName,
      lab: entry.lab,
      enabled: entry.enabled,
      config: {
        released: entry.released,
        reasoning: entry.reasoning,
        ...(entry.reasoningMandatory === undefined
          ? {}
          : { reasoningMandatory: entry.reasoningMandatory }),
        ...(entry.reasoningPrompt === undefined ? {} : { reasoningPrompt: entry.reasoningPrompt }),
        temperature: entry.temperature,
        rationale: entry.rationale,
        ...(entry.disabledReason === undefined ? {} : { disabledReason: entry.disabledReason }),
      },
    }).onConflictDoUpdate({
      target: models.slug,
      set: {
        displayName: entry.displayName,
        lab: entry.lab,
        enabled: entry.enabled,
        config: {
          released: entry.released,
          reasoning: entry.reasoning,
          ...(entry.reasoningMandatory === undefined
            ? {}
            : { reasoningMandatory: entry.reasoningMandatory }),
          ...(entry.reasoningPrompt === undefined ? {} : { reasoningPrompt: entry.reasoningPrompt }),
          temperature: entry.temperature,
          rationale: entry.rationale,
          ...(entry.disabledReason === undefined ? {} : { disabledReason: entry.disabledReason }),
        },
      },
    });
  }
}

export async function loadModelBenchStates(
  db: ArenaDatabaseClient,
): Promise<Map<string, ModelBenchState>> {
  const rows = await db.select({ slug: models.slug, benchState: models.benchState }).from(models);
  return new Map(rows.flatMap((row) => (
    isModelBenchState(row.benchState) ? [[row.slug, row.benchState] as const] : []
  )));
}

export async function persistModelBenchStates(
  db: ArenaDatabaseClient,
  modelSlugs: readonly string[],
  states: ReadonlyMap<string, ModelBenchState>,
): Promise<void> {
  await db.transaction(async (transaction) => {
    for (const slug of modelSlugs) {
      await transaction.update(models).set({ benchState: states.get(slug) ?? null })
        .where(eq(models.slug, slug));
    }
  });
}

export async function clearModelBenchState(
  db: ArenaDatabaseClient,
  slug: string,
): Promise<boolean> {
  const updated = await db.update(models).set({ benchState: null })
    .where(eq(models.slug, slug))
    .returning({ slug: models.slug });
  return updated.length > 0;
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

  const gameIds = gameRows.map((game) => game.id);
  const [playerRows, eventRows, traceRows] = await Promise.all([
    db.select().from(gamePlayers)
      .where(inArray(gamePlayers.gameId, gameIds))
      .orderBy(asc(gamePlayers.gameId), asc(gamePlayers.seat)),
    db.select({ payload: events.payload }).from(events)
      .where(inArray(events.gameId, gameIds))
      .orderBy(asc(events.id)),
    db.select({
      gameId: traces.gameId,
      playerId: traces.playerId,
      prompt: traces.prompt,
      reasoning: traces.reasoning,
      answer: traces.answer,
      usage: traces.usage,
      createdAt: traces.createdAt,
    }).from(traces)
      .where(inArray(traces.gameId, gameIds))
      .orderBy(asc(traces.createdAt), asc(traces.id)),
  ]);
  const budgetTracker = new BudgetMissTracker();
  const persistedBudget = new Map<string, Record<string, LobbyModelBudgetMetrics>>();
  const persistedBenchStates = new Map<string, Record<string, ModelBenchState>>();
  for (const player of playerRows) {
    budgetTracker.observe({
      type: "player.joined",
      gameId: player.gameId,
      player: { id: player.playerId, name: player.name, modelId: player.modelSlug },
      at: new Date(0).toISOString(),
    });
  }
  for (const event of eventRows) {
    budgetTracker.observe(event.payload);
    if (event.payload.type === "game.ended") {
      const budget = modelBudgetMetrics(event.payload.budget);
      if (budget) persistedBudget.set(event.payload.gameId, budget);
      if (event.payload.benchStates !== undefined) {
        persistedBenchStates.set(event.payload.gameId, Object.fromEntries(
          Object.entries(event.payload.benchStates).flatMap(([slug, state]) => (
            isModelBenchState(state) ? [[slug, state] as const] : []
          )),
        ));
      }
    }
  }
  for (const trace of traceRows) {
    const stored = trace.usage ?? {};
    const purpose = stored["purpose"];
    const budgetMiss = stored["budgetMiss"] === true;
    const reasoningVisible = typeof stored["reasoningVisible"] === "boolean"
      ? stored["reasoningVisible"]
      : undefined;
    const attempts = Array.isArray(stored["attempts"])
      ? stored["attempts"] as TraceEvent["attempts"]
      : undefined;
    const {
      attempts: _attempts,
      purpose: _purpose,
      budgetMiss: _budgetMiss,
      reasoningVisible: _reasoningVisible,
      ...usage
    } = stored;
    budgetTracker.observe({
      type: "trace.completed",
      gameId: trace.gameId,
      playerId: trace.playerId,
      ...(purpose === "answer" || purpose === "vote" || purpose === "thriplash" ? { purpose } : {}),
      prompt: trace.prompt,
      reasoning: trace.reasoning,
      ...(reasoningVisible === undefined ? {} : { reasoningVisible }),
      answer: trace.answer,
      ...(budgetMiss ? { budgetMiss: true } : {}),
      ...(attempts === undefined ? {} : { attempts }),
      ...(Object.keys(usage).length === 0 ? {} : {
        usage: usage as NonNullable<TraceEvent["usage"]>,
      }),
      at: trace.createdAt.toISOString(),
    });
  }
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
      ...(Object.keys(persistedBudget.get(game.id) ?? budgetTracker.metrics(game.id)).length === 0
        ? {}
        : { budget: persistedBudget.get(game.id) ?? budgetTracker.metrics(game.id) }),
      ...(persistedBenchStates.has(game.id)
        ? { benchStates: persistedBenchStates.get(game.id)! }
        : {}),
    };
  });
}
