import { describe, expect, it } from "vitest";

import { BudgetMissTracker } from "../src/budget-tracker.js";

describe("BudgetMissTracker", () => {
  it("counts distinct model fallbacks and watchdog actions once per operation", () => {
    const tracker = new BudgetMissTracker();
    tracker.observe({
      type: "player.joined",
      gameId: "g1",
      player: { id: "p1", name: "Slow", modelId: "lab/slow" },
      at: "2026-09-02T00:00:00Z",
    });
    tracker.observe({
      type: "trace.completed",
      gameId: "g1",
      playerId: "p1",
      purpose: "answer",
      prompt: "same operation",
      reasoning: "",
      answer: "no comment",
      budgetMiss: true,
      usage: { inputTokens: 1, outputTokens: 0, totalMs: 15_010 },
      at: "2026-09-02T00:00:15Z",
    });
    tracker.observe({
      type: "answer.submitted",
      gameId: "g1",
      round: 1,
      playerId: "p1",
      prompt: "same operation",
      answer: "",
      blank: true,
      latencyMs: 15_000,
      budgetMiss: true,
      at: "2026-09-02T00:00:15Z",
    });
    tracker.observe({
      type: "vote.cast",
      gameId: "g1",
      round: 1,
      playerId: "p1",
      prompt: "vote operation",
      choice: 0,
      budgetMiss: true,
      latencyMs: 10_000,
      at: "2026-09-02T00:00:25Z",
    });
    tracker.observe({
      type: "harness.error",
      gameId: "g1",
      playerId: "p1",
      reason: "watchdog",
      stateKey: "choice-2",
      message: "watchdog acted",
      at: "2026-09-02T00:00:26Z",
    });

    expect(tracker.metrics("g1")).toEqual({
      "lab/slow": {
        misses: 3,
        answerLatenciesMs: [15_010],
      },
    });
  });
});
