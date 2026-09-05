import { access, readFile } from "node:fs/promises";

import type { AnyEvent, Game } from "@quiparena/core";
import type { Player } from "@quiparena/jackbox";

import type { ArenaDatabaseClient } from "../db/client.js";
import { BudgetMissTracker } from "../budget-tracker.js";
import {
  abandonStaleGames,
  backfillCompletedGameScores,
  loadLobbyHistoryFromDb,
  loadModelBenchStates,
  persistModelBenchStates,
  syncRosterModels,
} from "../db/operations.js";
import {
  advanceBenchStates,
  deriveBenchStates,
  pickNextLobby,
  type BenchRule,
  type LobbyPickRationale,
  type LobbyGameHistory,
  type LobbyHistoryEntry,
  type LobbyModelBudgetMetrics,
  type ModelBenchState,
} from "../lobby.js";
import { computeRatings, type ComputeRatingsOptions, type RatingRun } from "../ratings.js";
import type { RosterModel } from "../registry.js";
import { placementsFromScores, scoreGame } from "../scoring.js";
import { WorkerEventBus } from "./bus.js";
import {
  GameAbortedError,
  DEFAULT_ANSWER_BUDGET_MS,
  DEFAULT_VOTE_BUDGET_MS,
  runGame,
  type RunGameOptions,
} from "./game-runner.js";
import type { GameClient } from "./seat.js";
import { RealGameClient } from "./seat-factory.js";
import { DbSink } from "./sinks.js";

export const DEFAULT_DAILY_SPEND_CAP_USD = 100;

export interface LoopLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

const DEFAULT_LOGGER: LoopLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

export interface RunLoopOptions {
  roomCode: string;
  roster: readonly RosterModel[];
  bus?: WorkerEventBus;
  roomFile?: string;
  recordDir?: string;
  credentialsFile?: string;
  db?: ArenaDatabaseClient;
  signal?: AbortSignal;
  dailySpendCapUsd?: number;
  players?: number;
  keep?: number;
  fixedModels?: readonly string[];
  answerBudgetMs?: number;
  voteBudgetMs?: number;
  maxBudgetMisses?: number;
  benchGames?: number;
  pollIntervalMs?: number;
  gameTimeoutMs?: number;
  gameClient?: GameClient;
  playerFactory?: RunGameOptions["playerFactory"];
  rng?: () => number;
  logger?: LoopLogger;
  ratingsOptions?: ComputeRatingsOptions;
  /** Completed history, oldest first, used when this process has no local DB. */
  seedHistory?: readonly LobbyGameHistory[];
  /** Stop after this many completed games. */
  maxGames?: number;
  /** File whose presence arms a graceful stop at the next game boundary. */
  stopFile?: string;
  /** Process-level graceful stop signal, sampled only between games. */
  stopRequested?: () => boolean;
  runGame?: (options: RunGameOptions) => Promise<Game>;
  onGame?: (game: Game, roster: readonly RosterModel[], ratings?: RatingRun) => void | Promise<void>;
}

export interface LoopResult {
  games: Game[];
  spentUsd: number;
  reason: "spend-cap" | "aborted" | "max-games" | "graceful-stop";
}

function positiveNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number`);
  return parsed;
}

function utcDay(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new GameAbortedError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      cleanup();
      reject(new GameAbortedError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function roomFileCode(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const code = (await readFile(path, "utf8")).trim().toUpperCase();
    return code || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function fileExists(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function roomStillExists(client: GameClient, roomCode: string): Promise<boolean> {
  try {
    await client.lookupRoom(roomCode);
    return true;
  } catch {
    return false;
  }
}

async function waitForReplacementRoom(
  client: GameClient,
  deadRoomCode: string,
  roomFile: string | undefined,
  pollIntervalMs: number,
  logger: LoopLogger,
  signal?: AbortSignal,
  stopRequested?: () => Promise<boolean>,
): Promise<string | null> {
  logger.error(
    `[quiparena/worker] ROOM ${deadRoomCode} IS GONE. Update ROOM_CODE or ${roomFile ?? "pass --room-file PATH"}.`,
  );
  for (;;) {
    if (signal?.aborted) throw new GameAbortedError();
    if (await stopRequested?.()) return null;
    const fileCode = await roomFileCode(roomFile);
    const envCode = process.env["ROOM_CODE"]?.trim().toUpperCase();
    const candidate = fileCode ?? envCode;
    if (candidate && candidate !== deadRoomCode && await roomStillExists(client, candidate)) {
      logger.info(`[quiparena/worker] using replacement room ${candidate}`);
      return candidate;
    }
    await delay(pollIntervalMs, signal);
  }
}

function lobbyScores(game: Game): Record<string, number> {
  if (game.observedScores) return { ...(game.finalScores ?? {}), ...game.observedScores };
  if (game.finalScores) return game.finalScores;
  const scores = Object.fromEntries(game.players.map((player) => [player.id, 0])) as Record<string, number>;
  for (const matchup of game.matchups) {
    for (const vote of matchup.votes) {
      const answer = matchup.answers[vote.choice];
      if (answer) scores[answer.playerId] = (scores[answer.playerId] ?? 0) + (vote.weight ?? 1) * matchup.round;
    }
  }
  if (game.thriplash) {
    for (const vote of game.thriplash.votes) {
      const entry = game.thriplash.entries[vote.choice];
      if (entry) scores[entry.playerId] = (scores[entry.playerId] ?? 0) + (vote.weight ?? 1) * 3;
    }
  }
  return scores;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lobbyBudget(value: unknown): Record<string, LobbyModelBudgetMetrics> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([slug, metrics]) => {
    if (!isRecord(metrics)) return [];
    const misses = metrics["misses"];
    const latencies = metrics["answerLatenciesMs"];
    if (!Number.isInteger(misses) || (misses as number) < 0 || !Array.isArray(latencies)
      || latencies.some((latency) => typeof latency !== "number" || !Number.isFinite(latency))) {
      return [];
    }
    return [[slug, {
      misses: misses as number,
      answerLatenciesMs: latencies as number[],
    }] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function lobbyBenchStates(value: unknown): Record<string, ModelBenchState> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([slug, state]) => {
    if (!isRecord(state)
      || typeof state["benched"] !== "boolean"
      || !Number.isInteger(state["gamesRemaining"])
      || !Number.isInteger(state["consecutiveSlowGames"])) return [];
    return [[slug, state as unknown as ModelBenchState] as const];
  }));
}

function historyApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = "/api/games";
  url.search = "?season=current";
  url.hash = "";
  return url;
}

/** Load completed rotation history from the public archive API behind --ingest. */
export async function loadLobbyHistoryFromApi(
  ingestUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<LobbyGameHistory[]> {
  const listUrl = historyApiUrl(ingestUrl);
  const response = await fetchImpl(listUrl, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`Game history API returned ${response.status} ${response.statusText}`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error("Game history API did not return an array");
  const completed = payload.filter((value): value is Record<string, unknown> => (
    isRecord(value)
    && typeof value["id"] === "string"
    && typeof value["startedAt"] === "string"
    && typeof value["endedAt"] === "string"
  )).sort((left, right) => String(left["startedAt"]).localeCompare(String(right["startedAt"])));

  return (await Promise.all(completed.map(async (summary) => {
    const gameUrl = new URL(`/api/games/${encodeURIComponent(String(summary["id"]))}`, listUrl);
    const gameResponse = await fetchImpl(gameUrl, signal ? { signal } : undefined);
    if (!gameResponse.ok) {
      throw new Error(`Game history API could not load ${String(summary["id"])}: ${gameResponse.status}`);
    }
    const archive: unknown = await gameResponse.json();
    const game = isRecord(archive) && isRecord(archive["game"])
      ? archive["game"]
      : archive;
    if (!isRecord(game) || typeof game["id"] !== "string" || !Array.isArray(game["players"])) {
      throw new Error(`Game history API returned a malformed archive for ${String(summary["id"])}`);
    }
    const corePlayers = game["players"].filter(isRecord).flatMap((player) => {
      const id = player["id"];
      const name = player["name"];
      const modelId = player["modelId"];
      return typeof id === "string" && typeof name === "string"
        && (typeof modelId === "string" || modelId === null)
        ? [{ id, name, modelId }]
        : [];
    });
    let finalScores = isRecord(game["finalScores"])
      ? Object.fromEntries(Object.entries(game["finalScores"]).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ))
      : undefined;
    if ((!finalScores || Object.keys(finalScores).length === 0) && Array.isArray(game["matchups"])) {
      const scoreable: Game = {
        id: game["id"],
        roomCode: typeof game["roomCode"] === "string" ? game["roomCode"] : "",
        startedAt: typeof game["startedAt"] === "string" ? game["startedAt"] : "",
        players: corePlayers,
        matchups: game["matchups"] as Game["matchups"],
        ...(isRecord(game["thriplash"]) ? { thriplash: game["thriplash"] as unknown as NonNullable<Game["thriplash"]> } : {}),
      };
      finalScores = scoreGame(scoreable).finalScores;
    }
    const observedScores = isRecord(game["observedScores"])
      ? Object.fromEntries(Object.entries(game["observedScores"]).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ))
      : undefined;
    if (observedScores && Object.keys(observedScores).length > 0) {
      finalScores = { ...(finalScores ?? {}), ...observedScores };
    }
    const observedPlacements = isRecord(game["observedPlacements"])
      ? Object.fromEntries(Object.entries(game["observedPlacements"]).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ))
      : undefined;
    const placements = observedPlacements && Object.keys(observedPlacements).length > 0
      ? observedPlacements
      : finalScores
        ? placementsFromScores(finalScores, corePlayers.map((player) => player.id))
        : {};
    const players = corePlayers.map((player) => ({
      id: player.id,
      playerId: player.id,
      modelId: player.modelId,
      modelSlug: player.modelId,
      ...(placements[player.id] === undefined ? {} : { placement: placements[player.id] }),
      ...(finalScores?.[player.id] === undefined ? {} : { totalScore: finalScores[player.id] }),
    }));
    const archivedEvents = isRecord(archive) && Array.isArray(archive["events"])
      ? archive["events"].filter(isRecord)
      : [];
    const endedEvents = archivedEvents.slice().reverse().filter((event) => event["type"] === "game.ended");
    const budget = endedEvents.flatMap((event) => (
      event["type"] === "game.ended" ? [lobbyBudget(event["budget"])] : []
    )).find((value) => value !== undefined);
    const benchStates = endedEvents.map((event) => lobbyBenchStates(event["benchStates"]))
      .find((value) => value !== undefined);
    return {
      id: game["id"],
      status: "completed",
      players,
      ...(finalScores === undefined ? {} : { finalScores }),
      ...(budget === undefined ? {} : { budget }),
      ...(benchStates === undefined ? {} : { benchStates }),
    } satisfies LobbyGameHistory;
  }))).filter((game) => game.players.length > 0);
}

function toHistory(
  game: Game,
  budget: Readonly<Record<string, LobbyModelBudgetMetrics>>,
): LobbyGameHistory {
  const rankingScores = lobbyScores(game);
  const ordered = Object.entries(rankingScores).sort((left, right) => right[1] - left[1]);
  const placement = new Map(game.observedPlacements
    ? Object.entries(game.observedPlacements)
    : ordered.map(([playerId], index): [string, number] => [playerId, index + 1]));
  return {
    id: game.id,
    players: game.players.map((player) => {
      const playerPlacement = placement.get(player.id);
      const totalScore = rankingScores[player.id];
      return {
        id: player.id,
        playerId: player.id,
        modelId: player.modelId,
        modelSlug: player.modelId,
        ...(playerPlacement === undefined ? {} : { placement: playerPlacement }),
        ...(totalScore === undefined ? {} : { totalScore }),
      };
    }),
    ...(Object.keys(rankingScores).length === 0 ? {} : { finalScores: rankingScores }),
    ...(Object.keys(budget).length === 0 ? {} : { budget }),
  };
}

/** Randomly sample eligible models for each game, rate games, and enforce spend. */
export async function runLoop(options: RunLoopOptions): Promise<LoopResult> {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const bus = options.bus ?? new WorkerEventBus();
  const gameClient = options.gameClient ?? new RealGameClient();
  const play = options.runGame ?? runGame;
  const size = options.players ?? 8;
  const keep = options.keep ?? 2;
  const answerBudgetMs = options.answerBudgetMs
    ?? positiveNumber(process.env["ANSWER_BUDGET_MS"], DEFAULT_ANSWER_BUDGET_MS, "ANSWER_BUDGET_MS");
  const voteBudgetMs = options.voteBudgetMs
    ?? positiveNumber(process.env["VOTE_BUDGET_MS"], DEFAULT_VOTE_BUDGET_MS, "VOTE_BUDGET_MS");
  if (answerBudgetMs <= 0) throw new Error("answerBudgetMs must be positive");
  if (voteBudgetMs <= 0) throw new Error("voteBudgetMs must be positive");
  const maxBudgetMisses = options.maxBudgetMisses
    ?? positiveNumber(process.env["MODEL_BUDGET_MISS_LIMIT"], 2, "MODEL_BUDGET_MISS_LIMIT");
  const benchGames = options.benchGames
    ?? positiveNumber(process.env["MODEL_BENCH_GAMES"], 10, "MODEL_BENCH_GAMES");
  if (!Number.isInteger(maxBudgetMisses)) throw new Error("maxBudgetMisses must be an integer");
  if (!Number.isInteger(benchGames) || benchGames < 1) {
    throw new Error("benchGames must be a positive integer");
  }
  const benchRule: Partial<BenchRule> = { answerBudgetMs, maxBudgetMisses, benchGames };
  const spendCap = options.dailySpendCapUsd
    ?? positiveNumber(process.env["DAILY_SPEND_CAP_USD"], DEFAULT_DAILY_SPEND_CAP_USD, "DAILY_SPEND_CAP_USD");
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  if (options.maxGames !== undefined && (!Number.isInteger(options.maxGames) || options.maxGames < 1)) {
    throw new Error("maxGames must be a positive integer");
  }
  let initialHistory = [...(options.seedHistory ?? [])];
  let benchStates = new Map<string, ModelBenchState>();
  if (options.db) {
    await syncRosterModels(options.db, options.roster);
    const abandoned = await abandonStaleGames(options.db);
    if (abandoned.length > 0) {
      logger.warn(`[quiparena/worker] abandoned stale games: ${abandoned.join(", ")}`);
    }
    const backfilled = await backfillCompletedGameScores(options.db);
    if (backfilled.length > 0) {
      logger.info(`[quiparena/worker] backfilled vote-derived scores: ${backfilled.join(", ")}`);
    }
    initialHistory = await loadLobbyHistoryFromDb(options.db);
    benchStates = await loadModelBenchStates(options.db);
  } else {
    benchStates = deriveBenchStates(initialHistory, benchRule);
  }
  const history: LobbyHistoryEntry[] = [...initialHistory];
  const gamesRun: Game[] = [];
  const budgetTracker = new BudgetMissTracker();
  let activeGameId: string | undefined;
  let currentDay = new Date().toISOString().slice(0, 10);
  let spentUsd = 0;
  let currentRoomCode = options.roomCode.trim().toUpperCase();
  let lastGame: LobbyGameHistory | null = initialHistory.at(-1) ?? null;
  let gracefulStopArmed = false;

  const shouldGracefullyStop = async (): Promise<boolean> => {
    if (gracefulStopArmed) return true;
    const signaled = options.stopRequested?.() ?? false;
    const filed = await fileExists(options.stopFile);
    if (!signaled && !filed) return false;
    gracefulStopArmed = true;
    const source = signaled && filed ? "SIGUSR1 + stop file" : signaled ? "SIGUSR1" : `stop file ${options.stopFile}`;
    logger.warn(`[quiparena/worker] graceful stop armed by ${source}; exiting at the game boundary`);
    return true;
  };

  const logPick = (pick: LobbyPickRationale<RosterModel>): void => {
    if (pick.role === "fixed") {
      logger.info(`[quiparena/worker] pick ${pick.model.displayName}: fixed games=${pick.gamesPlayed}`);
      return;
    }
    if (pick.role === "keeper") {
      logger.info(
        `[quiparena/worker] pick ${pick.model.displayName}: keeper`
        + `${pick.placement === undefined ? "" : ` placement=${pick.placement}`}`
        + `${pick.totalScore === undefined ? "" : ` points=${pick.totalScore}`}`
        + ` games=${pick.gamesPlayed}`,
      );
      return;
    }
    logger.info(
      `[quiparena/worker] pick ${pick.model.displayName}: rotation games=${pick.gamesPlayed}`
      + ` weight=${pick.weight ?? 0} ${pick.fresh ? "sat-out-last-game" : "refill"}`,
    );
  };

  const unsubscribe = bus.on((event: AnyEvent) => {
    budgetTracker.observe(event);
    if (event.type === "trace.completed" && event.usage?.costUsd !== undefined) {
      const eventDay = utcDay(event.at);
      if (eventDay !== currentDay) {
        currentDay = eventDay;
        spentUsd = 0;
      }
      spentUsd += event.usage.costUsd;
    }
  });
  const unsubscribeDb = options.db ? bus.addSink(new DbSink(options.db)) : undefined;

  try {
    for (;;) {
      if (options.signal?.aborted) {
        return { games: gamesRun, spentUsd, reason: "aborted" };
      }
      if (await shouldGracefullyStop()) {
        return { games: gamesRun, spentUsd, reason: "graceful-stop" };
      }
      if (options.db) benchStates = await loadModelBenchStates(options.db);
      const nextRoster = pickNextLobby({
        roster: options.roster,
        lastGame,
        history,
        size,
        keep,
        ...(options.fixedModels === undefined ? {} : { fixedModels: options.fixedModels }),
        bench: {
          ...benchRule,
        },
        benchStates,
        onPick: logPick,
        ...(options.rng === undefined ? {} : { rng: options.rng }),
      });
      activeGameId = `${currentRoomCode}-${Date.now()}-${gamesRun.length + 1}`;
      logger.info(`[quiparena/worker] game ${gamesRun.length + 1}: ${nextRoster.map((entry) => entry.displayName).join(", ")}`);
      let game: Game;
      try {
        game = await play({
          roomCode: currentRoomCode,
          roster: nextRoster,
          bus,
          gameId: activeGameId,
          ...(options.recordDir === undefined ? {} : { recordDir: options.recordDir }),
          ...(options.credentialsFile === undefined ? {} : { credentialsFile: options.credentialsFile }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.gameTimeoutMs === undefined ? {} : { timeoutMs: options.gameTimeoutMs }),
          gameClient,
          answerBudgetMs,
          voteBudgetMs,
          ...(options.playerFactory === undefined ? {} : { playerFactory: options.playerFactory }),
        });
      } catch (error) {
        if (error instanceof GameAbortedError || options.signal?.aborted) {
          return { games: gamesRun, spentUsd, reason: "aborted" };
        }
        logger.error(`[quiparena/worker] game in room ${currentRoomCode} failed`, error);
        if (!await roomStillExists(gameClient, currentRoomCode)) {
          const replacement = await waitForReplacementRoom(
            gameClient,
            currentRoomCode,
            options.roomFile,
            pollIntervalMs,
            logger,
            options.signal,
            shouldGracefullyStop,
          );
          if (!replacement) return { games: gamesRun, spentUsd, reason: "graceful-stop" };
          currentRoomCode = replacement;
        } else {
          await delay(pollIntervalMs, options.signal);
        }
        continue;
      }

      await bus.flush();
      gamesRun.push(game);
      const gameHistory = toHistory(game, budgetTracker.metrics(game.id));
      if (!game.finalScores) {
        logger.warn("[quiparena/worker] controller exposed no final scores; selecting keepers by weighted matchup votes");
      }
      history.push(gameHistory);
      lastGame = gameHistory;
      const benchUpdate = advanceBenchStates(benchStates, gameHistory, benchRule);
      benchStates = benchUpdate.states;
      for (const change of benchUpdate.changes) {
        const message = `[quiparena/worker] ${change.action} ${change.modelSlug}: ${change.reason}`
          + (change.action === "benched" ? `; ${change.gamesRemaining} games` : "");
        if (change.action === "benched") logger.warn(message);
        else logger.info(message);
      }
      if (options.db) {
        await persistModelBenchStates(
          options.db,
          options.roster.map((entry) => entry.slug),
          benchStates,
        );
      }
      bus.emit({
        type: "game.ended",
        gameId: game.id,
        ...(game.finalScores === undefined ? {} : { finalScores: game.finalScores }),
        budget: Object.fromEntries(Object.entries(gameHistory.budget ?? {}).map(([slug, metrics]) => [
          slug,
          { misses: metrics.misses, answerLatenciesMs: [...metrics.answerLatenciesMs] },
        ])),
        benchStates: Object.fromEntries(options.roster.map((entry) => [
          entry.slug,
          benchStates.get(entry.slug) ?? null,
        ])),
        at: game.endedAt ?? new Date().toISOString(),
      });
      await bus.flush();
      let ratings: RatingRun | undefined;
      if (options.db) ratings = await computeRatings(options.db, options.ratingsOptions);
      await options.onGame?.(game, nextRoster, ratings);

      if (spentUsd > spendCap) {
        logger.warn(`[quiparena/worker] daily spend $${spentUsd.toFixed(4)} exceeded cap $${spendCap.toFixed(2)}; stopping`);
        return { games: gamesRun, spentUsd, reason: "spend-cap" };
      }
      if (options.maxGames !== undefined && gamesRun.length >= options.maxGames) {
        return { games: gamesRun, spentUsd, reason: "max-games" };
      }
      if (await shouldGracefullyStop()) {
        return { games: gamesRun, spentUsd, reason: "graceful-stop" };
      }
      if (!await roomStillExists(gameClient, currentRoomCode)) {
        const replacement = await waitForReplacementRoom(
          gameClient,
          currentRoomCode,
          options.roomFile,
          pollIntervalMs,
          logger,
          options.signal,
          shouldGracefullyStop,
        );
        if (!replacement) return { games: gamesRun, spentUsd, reason: "graceful-stop" };
        currentRoomCode = replacement;
      }
    }
  } catch (error) {
    if (error instanceof GameAbortedError || options.signal?.aborted) {
      return { games: gamesRun, spentUsd, reason: "aborted" };
    }
    throw error;
  } finally {
    activeGameId = undefined;
    unsubscribe();
    unsubscribeDb?.();
    await bus.flush();
  }
}
