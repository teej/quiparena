import type { StreamEvent } from "@quiparena/core";

type ThinkingEvent = Extract<StreamEvent, { type: "thinking.delta" }>;

interface PendingThinking {
  event: ThinkingEvent;
  timer: ReturnType<typeof setTimeout>;
}

export class ThinkingCoalescer {
  private readonly pending = new Map<string, PendingThinking>();

  constructor(
    private readonly emit: (event: ThinkingEvent) => void,
    private readonly intervalMs = 100,
  ) {}

  push(event: ThinkingEvent): void {
    const key = this.key(event.gameId, event.playerId);
    const pending = this.pending.get(key);
    if (pending) {
      pending.event = { ...event, text: `${pending.event.text}${event.text}` };
      return;
    }
    const timer = setTimeout(() => this.flushKey(key), this.intervalMs);
    this.pending.set(key, { event: { ...event }, timer });
  }

  flushPlayer(gameId: string, playerId: string): void {
    this.flushKey(this.key(gameId, playerId));
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flushKey(key);
  }

  private key(gameId: string, playerId: string): string {
    return `${gameId}\u0000${playerId}`;
  }

  private flushKey(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    this.emit(pending.event);
  }
}
