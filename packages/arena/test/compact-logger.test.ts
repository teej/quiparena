import type { AnyEvent } from "@quiparena/core";
import { describe, expect, it } from "vitest";

import { CompactGameLogFormatter } from "../src/worker/compact-logger.js";

const at = "2026-09-02T00:00:00Z";

describe("CompactGameLogFormatter", () => {
  it("prints compact R3 answers and identifies Thriplash votes by entry owner", () => {
    const formatter = new CompactGameLogFormatter();
    const events: AnyEvent[] = [
      { type: "player.joined", gameId: "g", player: { id: "p1", name: "Alpha", modelId: "lab/a" }, at },
      { type: "player.joined", gameId: "g", player: { id: "p2", name: "Beta", modelId: "lab/b" }, at },
      { type: "answer.submitted", gameId: "g", round: 3, playerId: "p1", prompt: "Three", answer: ["first a", "second a", "third a"], blank: false, latencyMs: 1, at },
      { type: "answer.submitted", gameId: "g", round: 3, playerId: "p2", prompt: "Three", answer: ["first b", "second b", "third b"], blank: false, latencyMs: 1, at },
      { type: "vote.requested", gameId: "g", round: 3, playerId: "p1", prompt: "Three", options: ["FIRST A\nSECOND A\nTHIRD A", "FIRST B\nSECOND B\nTHIRD B"], deadlineMs: 1, at },
      { type: "vote.cast", gameId: "g", round: 3, playerId: "p1", prompt: "Three", choice: 1, at },
    ];
    const output = events.flatMap((event) => formatter.format(event).map((line) => line.text));

    expect(output.filter((line) => line === "R3 answers")).toHaveLength(1);
    expect(output).toContain("  Alpha → first a / second a / third a");
    expect(output).toContain("  vote Alpha → Beta");
    expect(output.at(-1)).not.toContain("\n");
  });

  it("makes watchdog metadata prominent", () => {
    const formatter = new CompactGameLogFormatter();
    const [output] = formatter.format({
      type: "harness.error",
      gameId: "g",
      playerId: "p1",
      message: "watchdog detected a missed action",
      reason: "state-timeout",
      stateKey: "MakeSingleChoice:42",
      missedOccurrences: 2,
      at,
    });
    expect(output).toEqual({
      level: "error",
      text: "!!! HARNESS ERROR p1: watchdog detected a missed action [reason=state-timeout state=MakeSingleChoice:42 missed=2] !!!",
    });
  });

  it("prints audience-observed results and final standings", () => {
    const formatter = new CompactGameLogFormatter();
    const result = formatter.format({
      type: "matchup.observed",
      gameId: "g",
      prompt: "Prompt",
      answers: ["LEFT", "RIGHT"],
      winner: 1,
      percentages: [17, 83],
      raw: {},
      at,
    });
    const standings = formatter.format({
      type: "standings.observed",
      gameId: "g",
      standings: [
        { name: "Beta", score: 2000, placement: 1 },
        { name: "Alpha", score: 1000, placement: 2 },
      ],
      winner: "Beta",
      raw: {},
      at,
    });
    expect(result[0]?.text).toBe("  observed LEFT vs RIGHT → winner #2 (17–83%)");
    expect(standings[0]?.text).toBe("observed final 1. Beta=2000  2. Alpha=1000");
  });
});
