import type { AnyEvent } from "@quiparena/core";
import type { Player, SeatCredentials } from "@quiparena/jackbox";

export interface WorkerRoom {
  code: string;
  maxPlayers?: number;
  locked?: boolean;
  full?: boolean;
  [key: string]: unknown;
}

export interface SeatWelcome {
  id: string | number;
  name: string;
}

/** Structural subset of Quiplash3Seat used by the worker and fake harness. */
export interface Seat {
  readonly player: Player;
  readonly gameId: string;
  readonly playerId: string | undefined;
  readonly credentials: SeatCredentials | undefined;
  connect(): Promise<SeatWelcome>;
  close(): Promise<void>;
  waitForGameEnd(): Promise<void>;
  waitUntilCanStart(timeoutMs?: number): Promise<void>;
  waitUntilAvatarSelected(timeoutMs?: number): Promise<void>;
  startIfVip(): Promise<boolean>;
}

export interface CreateSeatOptions {
  room: WorkerRoom;
  gameId: string;
  player: Player;
  credentials?: SeatCredentials;
  recordFile?: string;
  postGameAction: "newPlayers" | "samePlayers" | "none";
  onEvent: (event: AnyEvent) => void;
}

export interface AudienceObserverHandle {
  connect(): Promise<unknown>;
  close(): Promise<void>;
  waitForFinalStandings?(): Promise<void>;
}

export interface CreateAudienceObserverOptions {
  room: WorkerRoom;
  gameId: string;
  recordFile?: string;
  onEvent: (event: AnyEvent) => void;
}

/** Construction boundary implemented by the real ecast adapter and FakeHarness. */
export interface GameClient {
  /** True when the client already emits matchup/thriplash resolution events. */
  readonly eventsAreAggregated?: boolean;
  lookupRoom(roomCode: string): Promise<WorkerRoom>;
  createSeat(options: CreateSeatOptions): Seat;
  /** Optional for synthetic clients; the production adapter always provides it. */
  createAudienceObserver?(options: CreateAudienceObserverOptions): AudienceObserverHandle;
}
