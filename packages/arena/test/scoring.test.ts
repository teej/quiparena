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

  it("rounds displayed percentages before converting them to points", () => {
    expect(scoreMatchup(matchup(1, votes(0, 1, 1, 1, 1, 1))).scores)
      .toEqual({ a: 170, b: 930 });
    expect(scoreMatchup(matchup(2, votes(0, 1, 1, 1, 1, 1))).scores)
      .toEqual({ a: 340, b: 1_860 });
  });

  it("scores each real Thriplash pairing from a 6,000-point pool", () => {
    const thriplash: Thriplash = {
      gameId: "ZSAX-1788413979845-1",
      prompt: "Pair A",
      entries: [
        { playerId: "a", lines: ["a1", "a2", "a3"], prompt: "Pair A" },
        { playerId: "b", lines: ["b1", "b2", "b3"], prompt: "Pair A" },
        { playerId: "c", lines: ["c1", "c2", "c3"], prompt: "Pair B" },
        { playerId: "d", lines: ["d1", "d2", "d3"], prompt: "Pair B" },
      ],
      // ZSAX recorded 2/6 vs 4/6 (33/67) and a separate 0/6 vs 6/6.
      votes: votes(0, 0, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3),
    };
    expect(scoreThriplash(thriplash).scores)
      .toEqual({ a: 1_980, b: 4_620, c: 0, d: 6_750 });
  });

  it("does not add a Thriplash winner bonus to a tied pair", () => {
    const thriplash: Thriplash = {
      gameId: "BAVU-1788416543831-4",
      prompt: "Pair",
      entries: [
        { playerId: "a", lines: ["a1", "a2", "a3"], prompt: "Pair" },
        { playerId: "b", lines: ["b1", "b2", "b3"], prompt: "Pair" },
      ],
      votes: votes(0, 0, 0, 1, 1, 1),
    };
    expect(scoreThriplash(thriplash).scores).toEqual({ a: 3_000, b: 3_000 });
  });

  it("awards the Thriplash pool for a blank opponent without inventing missing votes", () => {
    const thriplash: Thriplash = {
      gameId: "GSKR-1788587749561-3",
      prompt: "Parents",
      entries: [
        { playerId: "fable", lines: ["", "", ""], prompt: "Parents" },
        { playerId: "astra", lines: ["Hamster", "Wi-Fi", "Mattress"], prompt: "Parents" },
        { playerId: "c", lines: ["c1", "c2", "c3"], prompt: "No captured votes" },
        { playerId: "d", lines: ["d1", "d2", "d3"], prompt: "No captured votes" },
        { playerId: "e", lines: ["", "", ""], prompt: "Both blank" },
        { playerId: "f", lines: [" ", "", ""], prompt: "Both blank" },
      ],
      votes: [],
    };
    expect(scoreThriplash(thriplash).scores)
      .toEqual({ fable: 0, astra: 6_000, c: 0, d: 0, e: 0, f: 0 });
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
