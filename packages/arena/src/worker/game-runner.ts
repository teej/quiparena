import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { AnyEvent, Game, Matchup, PlayerRef, Thriplash } from "@quiparena/core";
import {
  DEFAULT_ANSWER_TIMEOUT_MS,
  DEFAULT_VOTE_TIMEOUT_MS,
  GameAggregator,
  loadCredentials,
  saveCredentials,
  type Player,
  type SeatCredentials,
} from "@quiparena/jackbox";

import { GameContext } from "./game-context.js";
import { assignDisplayNames } from "../lobby.js";
import type { RosterModel } from "../registry.js";
import { scoreMatchup, scoreThriplash, totalScores } from "../scoring.js";
import { WorkerEventBus } from "./bus.js";
import { buildModelPlayer, RealGameClient, playerBindings } from "./seat-factory.js";
import type { GameClient, Seat } from "./seat.js";

export const DEFAULT_GAME_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_ANSWER_BUDGET_MS = DEFAULT_ANSWER_TIMEOUT_MS;
export const DEFAULT_VOTE_BUDGET_MS = DEFAULT_VOTE_TIMEOUT_MS;

function environmentBudget(name: "ANSWER_BUDGET_MS" | "VOTE_BUDGET_MS", fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

export class GameTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Game did not end within ${timeoutMs}ms`);
    this.name = "GameTimeoutError";
  }
}

export class GameAbortedError extends Error {
  constructor() {
    super("Game was aborted");
    this.name = "AbortError";
  }
}

export interface RunGameOptions {
  roomCode: string;
  roster: readonly RosterModel[];
  bus?: WorkerEventBus;
  recordDir?: string;
  credentialsFile?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  answerBudgetMs?: number;
  voteBudgetMs?: number;
  gameClient?: GameClient;
  playerFactory?: (entry: RosterModel, displayName: string, bus: WorkerEventBus) => Player;
  gameId?: string;
}

class GameAccumulator {
  readonly players = new Map<string, PlayerRef>();
  readonly matchups = new Map<string, Matchup>();
  thriplash?: Thriplash;
  startedAt?: string;
  endedAt?: string;
  finalScores?: Record<string, number>;
  observedScores?: Record<string, number>;
  observedPlacements?: Record<string, number>;

  constructor(readonly gameId: string, readonly roomCode: string) {}

  consume(event: AnyEvent): void {
    if (!("gameId" in event) || event.gameId !== this.gameId) return;
    switch (event.type) {
      case "game.created":
        this.startedAt ??= event.at;
        break;
      case "player.joined":
        this.players.set(event.player.id, event.player);
        break;
      case "game.started":
        this.startedAt = event.at;
        break;
      case "matchup.resolved":
        this.matchups.set(event.matchup.id, event.matchup);
        break;
      case "thriplash.resolved":
        this.thriplash = event.thriplash;
        break;
      case "standings.observed": {
        const playerByName = new Map([...this.players.values()].map((player) => [
          normalizedName(player.name),
          player.id,
        ]));
        const observed = Object.fromEntries(event.standings.flatMap((standing) => {
          const playerId = playerByName.get(normalizedName(standing.name));
          return playerId ? [[playerId, standing.score]] : [];
        }));
        const placements = Object.fromEntries(event.standings.flatMap((standing) => {
          const playerId = playerByName.get(normalizedName(standing.name));
          return playerId ? [[playerId, standing.placement]] : [];
        }));
        if (Object.keys(observed).length > 0) {
          this.observedScores = observed;
          this.observedPlacements = placements;
        }
        break;
      }
      case "game.ended":
        this.endedAt = event.at;
        if (event.finalScores) this.finalScores = event.finalScores;
        break;
      default:
        break;
    }
  }

  game(): Game {
    return {
      id: this.gameId,
      roomCode: this.roomCode,
      startedAt: this.startedAt ?? new Date().toISOString(),
      ...(this.endedAt === undefined ? {} : { endedAt: this.endedAt }),
      players: [...this.players.values()],
      matchups: [...this.matchups.values()].sort((left, right) => (
        left.round - right.round || left.index - right.index
      )),
      ...(this.thriplash === undefined ? {} : { thriplash: this.thriplash }),
      ...(this.finalScores === undefined ? {} : { finalScores: this.finalScores }),
      ...(this.observedScores === undefined ? {} : { observedScores: this.observedScores }),
      ...(this.observedPlacements === undefined ? {} : { observedPlacements: this.observedPlacements }),
    };
  }
}

function normalizedName(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

/** Adds deterministic arena scores before an event reaches any worker sink. */
class GameScoreTracker {
  readonly #players: string[] = [];
  readonly #matchups = new Map<string, Matchup>();
  #thriplash?: Thriplash;

  enrich(event: AnyEvent): AnyEvent {
    switch (event.type) {
      case "player.joined":
        if (!this.#players.includes(event.player.id)) this.#players.push(event.player.id);
        return event;
      case "matchup.resolved": {
        const matchup = scoreMatchup(event.matchup);
        this.#matchups.set(matchup.id, matchup);
        return { ...event, matchup };
      }
      case "thriplash.resolved": {
        const thriplash = scoreThriplash(event.thriplash);
        this.#thriplash = thriplash;
        return { ...event, thriplash };
      }
      case "game.ended":
        return {
          ...event,
          finalScores: totalScores({
            playerIds: this.#players,
            matchups: [...this.#matchups.values()],
            ...(this.#thriplash === undefined ? {} : { thriplash: this.#thriplash }),
          }),
        };
      default:
        return event;
    }
  }
}

async function existingCredentials(path: string | undefined): Promise<SeatCredentials[]> {
  if (!path) return [];
  try {
    await access(path);
    return await loadCredentials(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "_").replace(/^\.+/, "") || "seat";
}

function abortPromise(signal: AbortSignal | undefined): {
  promise: Promise<never>;
  dispose(): void;
} {
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  const handler = (): void => rejectPromise(new GameAbortedError());
  if (signal?.aborted) handler();
  else signal?.addEventListener("abort", handler, { once: true });
  return {
    promise,
    dispose: () => signal?.removeEventListener("abort", handler),
  };
}

/** Join a complete roster, start from the first connected (VIP) seat, and collect one Game. */
export async function runGame(options: RunGameOptions): Promise<Game> {
  const roomCode = options.roomCode.trim().toUpperCase();
  if (!roomCode) throw new Error("A room code is required");
  if (options.roster.length < 1) throw new Error("The game roster is empty");
  const timeoutMs = options.timeoutMs ?? DEFAULT_GAME_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  const answerBudgetMs = options.answerBudgetMs
    ?? environmentBudget("ANSWER_BUDGET_MS", DEFAULT_ANSWER_BUDGET_MS);
  const voteBudgetMs = options.voteBudgetMs
    ?? environmentBudget("VOTE_BUDGET_MS", DEFAULT_VOTE_BUDGET_MS);
  if (!Number.isFinite(answerBudgetMs) || answerBudgetMs <= 0) {
    throw new RangeError("answerBudgetMs must be positive");
  }
  if (!Number.isFinite(voteBudgetMs) || voteBudgetMs <= 0) {
    throw new RangeError("voteBudgetMs must be positive");
  }

  const bus = options.bus ?? new WorkerEventBus();
  const client: GameClient = options.gameClient ?? new RealGameClient();
  const room = await client.lookupRoom(roomCode);
  if (room.locked) throw new Error(`Room ${roomCode} is locked`);
  if (room.full) throw new Error(`Room ${roomCode} is full`);
  if (room.maxPlayers !== undefined && options.roster.length > room.maxPlayers) {
    throw new Error(`Room ${roomCode} accepts at most ${room.maxPlayers} players`);
  }

  const gameId = options.gameId ?? `${roomCode}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const accumulator = new GameAccumulator(gameId, roomCode);
  const scoreTracker = new GameScoreTracker();
  const gameContext = new GameContext(gameId);
  const emitScored = (event: AnyEvent): void => {
    gameContext.consume(event);
    bus.emit(scoreTracker.enrich(event));
  };
  const harnessAggregator = client.eventsAreAggregated
    ? undefined
    : new GameAggregator({
        gameId,
        expectedPlayerCount: options.roster.length,
        onEvent: emitScored,
      });
  const emitSeatEvent = (event: AnyEvent): void => {
    if (!harnessAggregator) {
      emitScored(event);
      return;
    }
    // The aggregator owns lifecycle events so eight seat controllers produce
    // one canonical game/round boundary. Seat-scoped events remain observable.
    const lifecycle = event.type === "game.created"
      || event.type === "game.started"
      || event.type === "round.started"
      || event.type === "game.ended";
    if (!lifecycle) emitScored(event);
    harnessAggregator.ingest(event);
  };
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const unsubscribe = bus.on((event) => {
    accumulator.consume(event);
    if (event.type === "game.ended" && event.gameId === gameId) resolveEnded();
  });
  const saved = await existingCredentials(options.credentialsFile);
  const connectedCredentials: SeatCredentials[] = [];
  const seats: Seat[] = [];
  const connected: Seat[] = [];
  const audience = client.createAudienceObserver?.({
    room,
    gameId,
    ...(options.recordDir === undefined
      ? {}
      : { recordFile: join(options.recordDir, "ecast", "audience.jsonl") }),
    onEvent: emitScored,
  });
  const assigned = assignDisplayNames(options.roster);
  const abort = abortPromise(options.signal);
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new GameTimeoutError(timeoutMs)), timeoutMs);
  });
  let audienceConnected = false;

  try {
    if (audience) {
      try {
        await Promise.race([audience.connect(), abort.promise, timedOut]);
        audienceConnected = true;
      } catch (error) {
        if (error instanceof GameTimeoutError || error instanceof GameAbortedError) throw error;
        bus.emit({
          type: "harness.error",
          gameId,
          message: `Could not join audience observer: ${error instanceof Error ? error.message : String(error)}`,
          at: new Date().toISOString(),
        });
      }
    }

    for (const [index, entry] of assigned.entries()) {
      if (options.signal?.aborted) throw new GameAbortedError();
      let player: Player;
      try {
        player = options.playerFactory
          ? options.playerFactory(entry, entry.displayName, bus)
          : buildModelPlayer(entry, entry.displayName, bus, {
              ...(process.env["OPENROUTER_API_KEY"] === undefined
                ? {}
                : { apiKey: process.env["OPENROUTER_API_KEY"] }),
            });
        const source = player;
        player = gameContext.wrap(source);
        const binding = playerBindings.get(source);
        if (binding) playerBindings.set(player, binding);
        const credential = saved.find((candidate) => (
          candidate.room === roomCode && candidate.name.toLocaleLowerCase() === player.name.toLocaleLowerCase()
        ));
        const seat = client.createSeat({
          room,
          gameId,
          player,
          ...(credential === undefined ? {} : { credentials: credential }),
          ...(options.recordDir === undefined
            ? {}
            : { recordFile: join(options.recordDir, "ecast", `${index + 1}-${safeFilename(player.name)}.jsonl`) }),
          postGameAction: "newPlayers",
          answerBudgetMs,
          voteBudgetMs,
          onEvent: emitSeatEvent,
        });
        seats.push(seat);
        await Promise.race([seat.connect(), abort.promise, timedOut]);
        connected.push(seat);
        if (seat.credentials) {
          connectedCredentials.push(seat.credentials);
          if (options.credentialsFile) {
            await saveCredentials(options.credentialsFile, connectedCredentials);
          }
        }
        try {
          await Promise.race([seat.waitUntilAvatarSelected(), abort.promise, timedOut]);
        } catch (error) {
          bus.emit({
            type: "harness.error",
            gameId,
            playerId: seat.playerId ?? entry.slug,
            message: error instanceof Error ? error.message : String(error),
            at: new Date().toISOString(),
          });
        }
      } catch (error) {
        if (error instanceof GameTimeoutError || error instanceof GameAbortedError) throw error;
        bus.emit({
          type: "harness.error",
          gameId,
          playerId: entry.slug,
          message: `Could not join ${entry.displayName}: ${error instanceof Error ? error.message : String(error)}`,
          at: new Date().toISOString(),
        });
      }
    }

    const vip = connected[0];
    if (!vip) throw new Error(`No seats joined room ${roomCode}`);
    await Promise.race([vip.waitUntilCanStart(), abort.promise, timedOut]);
    if (!await Promise.race([vip.startIfVip(), abort.promise, timedOut])) {
      throw new Error("The first connected seat is not the start-capable VIP");
    }

    await Promise.race([ended, abort.promise, timedOut]);
    // The VIP emits game.ended immediately before its configured post-game
    // action. Waiting for the seat boundary guarantees NEW PLAYERS was sent.
    await Promise.race([vip.waitForGameEnd(), abort.promise, timedOut]);
    if (audienceConnected && audience?.waitForFinalStandings) {
      try {
        await Promise.race([audience.waitForFinalStandings(), abort.promise, timedOut]);
      } catch (error) {
        if (error instanceof GameTimeoutError || error instanceof GameAbortedError) throw error;
        bus.emit({
          type: "harness.error",
          gameId,
          reason: "audience-parse",
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        });
      }
    }
    await bus.flush();
    return accumulator.game();
  } finally {
    if (timeout) clearTimeout(timeout);
    abort.dispose();
    unsubscribe();
    await Promise.allSettled([
      ...seats.map((seat) => seat.close()),
      ...(audience ? [audience.close()] : []),
    ]);
    await bus.flush();
  }
}
