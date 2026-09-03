import type { StreamEvent } from "@quiparena/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThinkingCoalescer } from "./coalescer.js";

type ThinkingEvent = Extract<StreamEvent, { type: "thinking.delta" }>;
const event = (playerId: string, text: string): ThinkingEvent => ({
  type: "thinking.delta",
  gameId: "g1",
  playerId,
  text,
  at: "2026-09-02T00:00:00.000Z",
});

describe("ThinkingCoalescer", () => {
  afterEach(() => vi.useRealTimers());

  it("emits at most one combined delta per player per interval", () => {
    vi.useFakeTimers();
    const emitted: ThinkingEvent[] = [];
    const coalescer = new ThinkingCoalescer((value) => emitted.push(value), 100);
    coalescer.push(event("p1", "one "));
    coalescer.push(event("p1", "two "));
    coalescer.push(event("p1", "three"));
    vi.advanceTimersByTime(99);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emitted.map((value) => value.text)).toEqual(["one two three"]);
  });

  it("buffers players independently and can flush ordering boundaries", () => {
    vi.useFakeTimers();
    const emitted: ThinkingEvent[] = [];
    const coalescer = new ThinkingCoalescer((value) => emitted.push(value), 100);
    coalescer.push(event("p1", "alpha"));
    coalescer.push(event("p2", "beta"));
    coalescer.flushPlayer("g1", "p1");
    expect(emitted.map((value) => [value.playerId, value.text])).toEqual([["p1", "alpha"]]);
    vi.advanceTimersByTime(100);
    expect(emitted.map((value) => [value.playerId, value.text])).toEqual([["p1", "alpha"], ["p2", "beta"]]);
  });
});
