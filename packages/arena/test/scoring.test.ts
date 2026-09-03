import type { Game, Matchup, Thriplash, Vote } from "@quiparena/core";
import { describe, expect, it } from "vitest";

import {
  placementsFromScores,
  scoreGame,
  scoreMatchup,
  scoreThriplash,
} from "../src/scoring.js";

function votes(...choices: number[]): Vote[] {
  return choices.map((choice, index) => ({
    voterId: `v${index}`,
    population: "player",
    choice,
  }));
}

function matchup(round: 1 | 2, gameVotes: Vote[]): Matchup {
  return {
    id: `m${round}`,
    gameId: "g",
    round,
    index: 0,
    prompt: "Prompt",
    answers: [
      { playerId: "a", text: "Alpha", blank: false },
      { playerId: "b", text: "Beta", blank: false },
    ],
    votes: gameVotes,
  };
}

describe("Quiplash 3 scoring", () => {
  it("splits the R1/R2 pools by vote share and applies the scaled win bonus", () => {
    expect(scoreMatchup(matchup(1, votes(0, 0, 0, 1))).scores).toEqual({ a: 850, b: 250 });
    expect(scoreMatchup(matchup(2, votes(0, 0, 0, 1))).scores).toEqual({ a: 1_700, b: 500 });
  });

  it("uses the Quiplash bonus instead of the ordinary winner bonus", () => {
    expect(scoreMatchup(matchup(1, votes(0, 0, 0))).scores).toEqual({ a: 1_250, b: 0 });
    expect(scoreMatchup(matchup(2, votes(1, 1, 1))).scores).toEqual({ a: 0, b: 2_500 });
  });

  it("splits a 3,000-point Thriplash pool across every normalized entry", () => {
    const thriplash: Thriplash = {
      gameId: "g",
      prompt: "Three things",
      entries: [
        { playerId: "a", lines: ["a1", "a2", "a3"] },
        { playerId: "b", lines: ["b1", "b2", "b3"] },
        { playerId: "c", lines: ["c1", "c2", "c3"] },
      ],
      votes: votes(0, 1, 1, 2, 2, 2),
    };
    expect(scoreThriplash(thriplash).scores).toEqual({ a: 500, b: 1_000, c: 1_800 });
    expect(scoreThriplash({ ...thriplash, votes: votes(2, 2) }).scores)
      .toEqual({ a: 0, b: 0, c: 3_750 });
  });

  it("totals a game, keeps nested score maps, and shares tied placements", () => {
    const game: Game = {
      id: "g",
      roomCode: "TEST",
      startedAt: "2026-09-02T00:00:00Z",
      players: [
        { id: "a", name: "A", modelId: "lab/a" },
        { id: "b", name: "B", modelId: "lab/b" },
        { id: "c", name: "C", modelId: "lab/c" },
      ],
      matchups: [matchup(1, votes(0, 1))],
    };
    const scored = scoreGame(game);
    expect(scored.matchups[0]?.scores).toEqual({ a: 500, b: 500 });
    expect(scored.finalScores).toEqual({ a: 500, b: 500, c: 0 });
    expect(placementsFromScores(scored.finalScores!, ["a", "b", "c"]))
      .toEqual({ a: 1, b: 1, c: 3 });
  });
});
