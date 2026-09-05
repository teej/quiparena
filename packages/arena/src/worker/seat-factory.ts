import type { AnyEvent, GameEvent, StreamEvent } from "@quiparena/core";
import {
  AudienceObserver,
  EcastConnection,
  Quiplash3Seat,
  lookupRoom,
  type Player,
  type PlayerContext,
  type RoomInfo,
  type SeatCredentials,
} from "@quiparena/jackbox";

import { ModelPlayer, type ModelPlayerConfig } from "../model-player.js";
import type { RosterModel } from "../registry.js";
import type { EventPublisher, WorkerEventBus } from "./bus.js";
import type {
  AudienceObserverHandle,
  CreateAudienceObserverOptions,
  CreateSeatOptions,
  GameClient,
  Seat,
  SeatWelcome,
  WorkerRoom,
} from "./seat.js";

export const playerBindings = new WeakMap<Player, (playerId: string) => void>();

export interface BuildModelPlayerOptions {
  apiKey?: string;
  config?: Partial<Pick<ModelPlayerConfig, "answerLimit" | "fallback" | "safetyMarginMs" | "languageModel" | "random">>;
}

/** Build a roster-backed model player whose trace events share the worker bus. */
export function buildModelPlayer(
  entry: RosterModel,
  displayName: string,
  bus: WorkerEventBus,
  options: BuildModelPlayerOptions = {},
): ModelPlayer {
  let boundPlayerId = entry.slug;
  const player = new ModelPlayer({
    model: entry.slug,
    displayName,
    playerId: entry.slug,
    ...(entry.reasoning === null ? {} : { reasoning: entry.reasoning }),
    ...(entry.reasoningMandatory === undefined
      ? {}
      : { reasoningMandatory: entry.reasoningMandatory }),
    ...(entry.reasoningPrompt === undefined ? {} : { reasoningPrompt: entry.reasoningPrompt }),
    ...(entry.temperature === null ? {} : { temperature: entry.temperature }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...options.config,
    sink: (event: StreamEvent) => bus.emit({ ...event, playerId: boundPlayerId }),
    onFailure: (error, ctx) => {
      bus.emit({
        type: "harness.error",
        gameId: ctx.gameId,
        playerId: boundPlayerId,
        message: error.message,
        at: new Date().toISOString(),
      });
    },
  });
  playerBindings.set(player, (playerId) => {
    boundPlayerId = playerId;
  });
  return player;
}

function fallbackPlayer(
  player: Player,
  gameId: string,
  bus: EventPublisher,
  currentPlayerId: () => string | undefined,
): Player {
  const report = (error: unknown): void => {
    const event: GameEvent = {
      type: "harness.error",
      gameId,
      playerId: currentPlayerId() ?? player.modelId ?? player.name,
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    bus.emit(event);
  };

  const beforeDeadline = async <T>(work: () => Promise<T>, ctx: PlayerContext, fallback: T): Promise<T> => {
    const remainingMs = Math.max(0, ctx.deadlineMs - Date.now());
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(work).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        new Promise<{ ok: false; timeout: true }>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, timeout: true }), remainingMs);
        }),
      ]);
      if (!result.ok) {
        report("timeout" in result ? new Error(`${player.name} timed out`) : result.error);
        return fallback;
      }
      return result.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    name: player.name,
    modelId: player.modelId,
    answer: (prompt, ctx) => beforeDeadline(() => player.answer(prompt, ctx), ctx, ""),
    answerFinal: (prompt, ctx) => beforeDeadline(
      () => player.answerFinal(prompt, ctx),
      ctx,
      ["", "", ""] as [string, string, string],
    ),
    vote: (prompt, options, ctx) => beforeDeadline(() => player.vote(prompt, options, ctx), ctx, 0),
  };
}

class RealSeatAdapter implements Seat {
  readonly #seat: Quiplash3Seat;
  readonly #sourcePlayer: Player;

  constructor(seat: Quiplash3Seat, sourcePlayer: Player) {
    this.#seat = seat;
    this.#sourcePlayer = sourcePlayer;
  }

  get player(): Player {
    return this.#sourcePlayer;
  }

  get gameId(): string {
    return this.#seat.gameId;
  }

  get playerId(): string | undefined {
    return this.#seat.playerId;
  }

  get credentials(): SeatCredentials | undefined {
    return this.#seat.connection.credentials;
  }

  async connect(): Promise<SeatWelcome> {
    const welcome = await this.#seat.connect();
    playerBindings.get(this.#sourcePlayer)?.(String(welcome.id));
    return welcome;
  }

  close(): Promise<void> {
    return this.#seat.close();
  }

  waitForGameEnd(): Promise<void> {
    return this.#seat.waitForGameEnd();
  }

  waitUntilCanStart(timeoutMs?: number): Promise<void> {
    return this.#seat.waitUntilCanStart(timeoutMs);
  }

  waitUntilAvatarSelected(timeoutMs?: number): Promise<void> {
    return this.#seat.waitUntilAvatarSelected(timeoutMs);
  }

  startIfVip(): Promise<boolean> {
    return this.#seat.startIfVip();
  }
}

/** Build the real harness seat and route every harness event onto one bus. */
export function buildHarnessSeat(options: CreateSeatOptions, bus: EventPublisher): Seat {
  let playerId: string | undefined;
  const player = fallbackPlayer(options.player, options.gameId, bus, () => playerId);
  const connection = new EcastConnection({
    room: options.room as unknown as RoomInfo,
    name: options.player.name,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.recordFile === undefined ? {} : { recordFile: options.recordFile }),
  });
  const seat = new Quiplash3Seat(connection, player, {
    gameId: options.gameId,
    ...(options.answerBudgetMs === undefined ? {} : {
      defaultAnswerTimeoutMs: options.answerBudgetMs,
      defaultThriplashTimeoutMs: options.answerBudgetMs,
    }),
    ...(options.voteBudgetMs === undefined ? {} : {
      defaultVoteTimeoutMs: options.voteBudgetMs,
    }),
    postGameAction: options.postGameAction,
    onEvent: (event: AnyEvent) => {
      if (event.type === "player.joined") playerId = event.player.id;
      options.onEvent(event);
    },
  });
  return new RealSeatAdapter(seat, options.player);
}

export class RealGameClient implements GameClient {
  async lookupRoom(roomCode: string): Promise<WorkerRoom> {
    const room = await lookupRoom(roomCode);
    if (room.appTag !== "quiplash3" && room.appTag !== "quiplash3-tjsp") {
      throw new Error(`Room ${room.code} is ${String(room.appTag)}, not Quiplash 3`);
    }
    return room;
  }

  createSeat(options: CreateSeatOptions): Seat {
    const bus = new BusForwarder(options.onEvent);
    return buildHarnessSeat(options, bus);
  }

  createAudienceObserver(options: CreateAudienceObserverOptions): AudienceObserverHandle {
    return new AudienceObserver({
      gameId: options.gameId,
      room: options.room as unknown as RoomInfo,
      lookupRoom,
      ...(options.recordFile === undefined ? {} : { recordFile: options.recordFile }),
      onEvent: options.onEvent,
    });
  }
}

export const createModelPlayer = buildModelPlayer;
export const createHarnessSeat = buildHarnessSeat;

/** Keeps RealGameClient usable through the GameClient boundary without a second callback path. */
class BusForwarder implements EventPublisher {
  constructor(readonly forward: (event: AnyEvent) => void) {}

  emit(event: AnyEvent): void {
    this.forward(event);
  }

}
