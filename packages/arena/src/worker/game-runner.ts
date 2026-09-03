import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { AnyEvent, Game, Matchup, PlayerRef, Thriplash } from "@quiparena/core";
import {
  GameAggregator,
  loadCredentials,
  saveCredentials,
  type Player,
  type SeatCredentials,
} from "@quiparena/jackbox";

import { assignDisplayNames } from "../lobby.js";
import type { RosterModel } from "../registry.js";
import { WorkerEventBus } from "./bus.js";
import { buildModelPlayer, RealGameClient } from "./seat-factory.js";
import type { GameClient, Seat } from "./seat.js";

export const DEFAULT_GAME_TIMEOUT_MS = 20 * 60_000;

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
    };
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
  const harnessAggregator = client.eventsAreAggregated
    ? undefined
    : new GameAggregator({
        gameId,
        expectedPlayerCount: options.roster.length,
        onEvent: (event) => bus.emit(event),
      });
  const emitSeatEvent = (event: AnyEvent): void => {
    if (!harnessAggregator) {
      bus.emit(event);
      return;
    }
    // The aggregator owns the terminal event so its resolved matchups are
    // ordered before game.ended. All other per-seat events remain observable.
    if (event.type !== "game.ended") bus.emit(event);
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
  const assigned = assignDisplayNames(options.roster);
  const abort = abortPromise(options.signal);
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new GameTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
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
    await bus.flush();
    return accumulator.game();
  } finally {
    if (timeout) clearTimeout(timeout);
    abort.dispose();
    unsubscribe();
    await Promise.allSettled(seats.map((seat) => seat.close()));
    await bus.flush();
  }
}
