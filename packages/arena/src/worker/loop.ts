import { readFile } from "node:fs/promises";

import type { AnyEvent, Game } from "@quiparena/core";
import type { Player } from "@quiparena/jackbox";

import type { ArenaDatabaseClient } from "../db/client.js";
import {
  pickNextLobby,
  type LobbyGameHistory,
  type LobbyHistoryEntry,
} from "../lobby.js";
import { computeRatings, type ComputeRatingsOptions, type RatingRun } from "../ratings.js";
import type { RosterModel } from "../registry.js";
import { WorkerEventBus } from "./bus.js";
import {
  GameAbortedError,
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
  benchFailures?: number;
  pollIntervalMs?: number;
  gameTimeoutMs?: number;
  gameClient?: GameClient;
  playerFactory?: RunGameOptions["playerFactory"];
  rng?: () => number;
  logger?: LoopLogger;
  ratingsOptions?: ComputeRatingsOptions;
  /** Test/ops escape hatch; the CLI intentionally leaves this unset. */
  maxGames?: number;
  runGame?: (options: RunGameOptions) => Promise<Game>;
  onGame?: (game: Game, roster: readonly RosterModel[], ratings?: RatingRun) => void | Promise<void>;
}

export interface LoopResult {
  games: Game[];
  spentUsd: number;
  reason: "spend-cap" | "aborted" | "max-games";
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
): Promise<string> {
  logger.error(
    `[quiparena/worker] ROOM ${deadRoomCode} IS GONE. Update ROOM_CODE or ${roomFile ?? "pass --room-file PATH"}.`,
  );
  for (;;) {
    if (signal?.aborted) throw new GameAbortedError();
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

function toHistory(game: Game, failures: ReadonlySet<string>): LobbyGameHistory {
  const rankingScores = lobbyScores(game);
  const ordered = Object.entries(rankingScores).sort((left, right) => right[1] - left[1]);
  const placement = new Map(ordered.map(([playerId], index) => [playerId, index + 1]));
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
    ...(game.finalScores === undefined ? {} : { finalScores: game.finalScores }),
    failures: [...failures],
  };
}

/** Continuously rotate six seats, retain two winners, rate games, and enforce spend. */
export async function runLoop(options: RunLoopOptions): Promise<LoopResult> {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const bus = options.bus ?? new WorkerEventBus();
  const gameClient = options.gameClient ?? new RealGameClient();
  const play = options.runGame ?? runGame;
  const size = options.players ?? 8;
  const keep = options.keep ?? 2;
  const benchFailures = options.benchFailures
    ?? positiveNumber(process.env["MODEL_FAILURE_BENCH_GAMES"], 2, "MODEL_FAILURE_BENCH_GAMES");
  if (!Number.isInteger(benchFailures) || benchFailures < 1) {
    throw new Error("benchFailures must be a positive integer");
  }
  const spendCap = options.dailySpendCapUsd
    ?? positiveNumber(process.env["DAILY_SPEND_CAP_USD"], DEFAULT_DAILY_SPEND_CAP_USD, "DAILY_SPEND_CAP_USD");
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const history: LobbyHistoryEntry[] = [];
  const gamesRun: Game[] = [];
  const failuresByGame = new Map<string, Set<string>>();
  const playerModels = new Map<string, string>();
  const rosterSlugs = new Set(options.roster.map((entry) => entry.slug));
  let activeGameId: string | undefined;
  let currentDay = new Date().toISOString().slice(0, 10);
  let spentUsd = 0;
  let currentRoomCode = options.roomCode.trim().toUpperCase();
  let lastGame: LobbyGameHistory | null = null;

  const unsubscribe = bus.on((event: AnyEvent) => {
    if (event.type === "trace.completed" && event.usage?.costUsd !== undefined) {
      const eventDay = utcDay(event.at);
      if (eventDay !== currentDay) {
        currentDay = eventDay;
        spentUsd = 0;
      }
      spentUsd += event.usage.costUsd;
    }
    if (event.type === "player.joined" && event.player.modelId) {
      playerModels.set(`${event.gameId}\0${event.player.id}`, event.player.modelId);
    }
    if (event.type === "harness.error") {
      const gameId = event.gameId ?? activeGameId;
      if (!gameId) return;
      const model = event.playerId
        ? playerModels.get(`${gameId}\0${event.playerId}`)
          ?? (rosterSlugs.has(event.playerId) ? event.playerId : undefined)
        : undefined;
      if (model) {
        const failures = failuresByGame.get(gameId) ?? new Set<string>();
        failures.add(model);
        failuresByGame.set(gameId, failures);
      }
    }
  });
  const unsubscribeDb = options.db ? bus.addSink(new DbSink(options.db)) : undefined;

  try {
    for (;;) {
      if (options.signal?.aborted) {
        return { games: gamesRun, spentUsd, reason: "aborted" };
      }
      const nextRoster = pickNextLobby({
        roster: options.roster,
        lastGame,
        history,
        size,
        keep,
        bench: {
          consecutiveFailures: benchFailures,
          lookback: Math.max(6, benchFailures),
        },
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
          ...(options.playerFactory === undefined ? {} : { playerFactory: options.playerFactory }),
        });
      } catch (error) {
        if (error instanceof GameAbortedError || options.signal?.aborted) {
          return { games: gamesRun, spentUsd, reason: "aborted" };
        }
        logger.error(`[quiparena/worker] game in room ${currentRoomCode} failed`, error);
        if (!await roomStillExists(gameClient, currentRoomCode)) {
          currentRoomCode = await waitForReplacementRoom(
            gameClient,
            currentRoomCode,
            options.roomFile,
            pollIntervalMs,
            logger,
            options.signal,
          );
        } else {
          await delay(pollIntervalMs, options.signal);
        }
        continue;
      }

      await bus.flush();
      gamesRun.push(game);
      const gameHistory = toHistory(game, failuresByGame.get(game.id) ?? new Set());
      if (!game.finalScores) {
        logger.warn("[quiparena/worker] controller exposed no final scores; selecting keepers by weighted matchup votes");
      }
      history.push(gameHistory);
      lastGame = gameHistory;
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
      if (!await roomStillExists(gameClient, currentRoomCode)) {
        currentRoomCode = await waitForReplacementRoom(
          gameClient,
          currentRoomCode,
          options.roomFile,
          pollIntervalMs,
          logger,
          options.signal,
        );
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
