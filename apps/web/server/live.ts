import type { AnyEvent } from "@quiparena/core";

import { createEmptyLiveState, isGameEvent, reduceLiveState } from "../shared/reducer.js";
import type { LiveState } from "../shared/types.js";
import { ThinkingCoalescer } from "./coalescer.js";
import type { Store } from "./store.js";

const EVENT_TYPES = new Set([
  "game.created",
  "player.joined",
  "game.started",
  "round.started",
  "prompt.dealt",
  "answer.submitted",
  "vote.requested",
  "vote.cast",
  "matchup.resolved",
  "thriplash.resolved",
  "game.ended",
  "harness.error",
  "thinking.delta",
  "answer.draft",
  "trace.completed",
]);

export function parseIngestEvent(value: unknown): AnyEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["type"] !== "string" || !EVENT_TYPES.has(candidate["type"])) return null;
  if (typeof candidate["gameId"] !== "string" || candidate["gameId"].length === 0) return null;
  return candidate as unknown as AnyEvent;
}

type Subscriber = (event: AnyEvent) => void;

export class LiveCoordinator {
  private currentState: LiveState = createEmptyLiveState();
  private readonly subscribers = new Set<Subscriber>();
  private readonly coalescer: ThinkingCoalescer;

  constructor(private readonly store: Store, coalesceMs = 100) {
    this.coalescer = new ThinkingCoalescer((event) => this.applyAndBroadcast(event), coalesceMs);
  }

  get state(): LiveState {
    return this.currentState;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async accept(event: AnyEvent): Promise<void> {
    if (event.type === "thinking.delta") {
      this.coalescer.push(event);
      return;
    }
    if (event.type === "game.created") this.coalescer.flushAll();
    if (typeof event.gameId === "string" && "playerId" in event && typeof event.playerId === "string") {
      this.coalescer.flushPlayer(event.gameId, event.playerId);
    }
    this.applyAndBroadcast(event);
    if (isGameEvent(event)) await this.store.saveEvent(event, this.currentState.traces);
  }

  close(): void {
    this.coalescer.flushAll();
    this.subscribers.clear();
  }

  private applyAndBroadcast(event: AnyEvent): void {
    this.currentState = reduceLiveState(this.currentState, event);
    for (const subscriber of this.subscribers) subscriber(event);
  }
}
