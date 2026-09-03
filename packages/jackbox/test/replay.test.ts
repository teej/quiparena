import { fileURLToPath } from "node:url";

import type { GameEvent } from "@quiparena/core";
import { describe, expect, it } from "vitest";

import { GameAggregator } from "../src/aggregator.js";
import { replayDirectory } from "../src/replay.js";

const recordingDir = fileURLToPath(new URL("./fixtures/VWIJ-1", import.meta.url));

describe("recording replay", () => {
  it("sends exactly one action for every real VWIJ-1 gameplay-state occurrence", async () => {
    const reports = await replayDirectory(recordingDir);

    expect(reports).toHaveLength(8);
    for (const report of reports) {
      expect(report.statesSeen).toEqual({
        EnterSingleText: 3,
        EnterTextList: 0,
        MakeSingleChoice: 6,
      });
      expect(report.actionsSent).toEqual(report.statesSeen);
      expect(report.missedStates).toEqual([]);
      expect(report.extraActions).toEqual([]);
      expect(report.unassignedActions).toBe(0);
      expect(report.ok).toBe(true);
    }

    const qa1 = reports[0];
    expect(qa1?.events.filter((event) => event.type === "answer.submitted")).toHaveLength(3);
    expect(qa1?.events.filter((event) => event.type === "vote.cast")).toHaveLength(6);

    const aggregated: GameEvent[] = [];
    const aggregator = new GameAggregator({
      gameId: "replay-VWIJ",
      expectedPlayerCount: 8,
      onEvent: (event) => aggregated.push(event),
    });
    for (const report of reports) {
      for (const event of report.events) aggregator.ingest(event);
    }
    const matchups = aggregated.filter((event) => event.type === "matchup.resolved");
    expect(matchups).toHaveLength(8);
    for (const event of matchups) {
      expect(event.matchup.answers).toHaveLength(2);
      expect(event.matchup.votes).toHaveLength(6);
      expect(event.matchup.prompt).not.toMatch(/vote for your favorite/i);
      expect(event.matchup.answers.every((answer) => /tiny horse|moon's least/i.test(answer.text)))
        .toBe(true);
    }
  }, 30_000);
});
