import { describe, expect, it } from "vitest";

import {
  advanceBenchStates,
  assignDisplayNames,
  pickNextLobby,
  type ModelBenchState,
} from "../src/lobby.js";

const roster = Array.from({ length: 9 }, (_, index) => ({
  slug: `lab/model-${index}`,
  displayName: `Model ${index}`,
  enabled: index !== 8,
}));

describe("pickNextLobby", () => {
  it("keeps top finishers, rotates without duplicates, favors underplayed models, and excludes benches", () => {
    const lastGame = {
      id: "last",
      players: [
        { id: "p0", modelId: "lab/model-0" },
        { id: "p1", modelId: "lab/model-1" },
        { id: "p2", modelId: "lab/model-2" },
        { id: "p3", modelId: "lab/model-3" },
      ],
      finalScores: { p0: 100, p1: 400, p2: 300, p3: 200 },
    };
    const history = [
      { players: ["lab/model-0", "lab/model-1", "lab/model-2", "lab/model-3", "lab/model-4"] },
      lastGame,
    ];
    const benchStates = new Map<string, ModelBenchState>([["lab/model-6", {
      benched: true,
      gamesRemaining: 10,
      consecutiveSlowGames: 0,
      reason: "too slow",
    }]]);
    const lobby = pickNextLobby({
      roster,
      lastGame,
      history,
      benchStates,
      size: 5,
      keep: 2,
      rng: () => 0.5,
    });
    const slugs = lobby.map((model) => model.slug);

    expect(slugs.slice(0, 2)).toEqual(["lab/model-1", "lab/model-2"]);
    expect(new Set(slugs).size).toBe(5);
    expect(slugs).not.toContain("lab/model-6");
    expect(slugs).not.toContain("lab/model-8");
    expect(slugs).toContain("lab/model-5");
  });

  it("can disable the bench rule", () => {
    const lobby = pickNextLobby({
      roster: roster.slice(0, 4),
      lastGame: null,
      history: [
        {
          players: ["lab/model-0"],
          budget: { "lab/model-0": { misses: 3, answerLatenciesMs: [] } },
        },
      ],
      size: 4,
      keep: 0,
      bench: false,
      rng: () => 0,
    });
    expect(lobby).toHaveLength(4);
  });
});

describe("automatic bench rule", () => {
  const game = (
    id: string,
    metrics: { misses: number; answerLatenciesMs: number[] },
  ) => ({
    id,
    players: ["lab/model-0"],
    budget: { "lab/model-0": metrics },
  });

  it("benches after more than two misses in one game", () => {
    const update = advanceBenchStates(new Map(), game("g1", {
      misses: 3,
      answerLatenciesMs: [2_000, 3_000],
    }));
    expect(update.states.get("lab/model-0")).toMatchObject({
      benched: true,
      gamesRemaining: 10,
      reason: expect.stringContaining("3 budget misses"),
    });
  });

  it("benches after two consecutive games over the p50 answer budget", () => {
    const first = advanceBenchStates(new Map(), game("g1", {
      misses: 0,
      answerLatenciesMs: [15_001, 16_000, 17_000],
    }));
    expect(first.states.get("lab/model-0")).toMatchObject({
      benched: false,
      consecutiveSlowGames: 1,
    });
    const second = advanceBenchStates(first.states, game("g2", {
      misses: 0,
      answerLatenciesMs: [15_500],
    }));
    expect(second.states.get("lab/model-0")).toMatchObject({
      benched: true,
      gamesRemaining: 10,
      reason: expect.stringContaining("2 consecutive games"),
    });
  });

  it("releases a bench only after ten subsequent games", () => {
    let states = advanceBenchStates(new Map(), game("trigger", {
      misses: 3,
      answerLatenciesMs: [],
    })).states;
    for (let index = 1; index <= 9; index += 1) {
      states = advanceBenchStates(states, { id: `other-${index}`, players: [] }).states;
      expect(states.get("lab/model-0")?.benched).toBe(true);
    }
    const released = advanceBenchStates(states, { id: "other-10", players: [] });
    expect(released.states.has("lab/model-0")).toBe(false);
    expect(released.changes).toContainEqual(expect.objectContaining({ action: "unbenched" }));
  });
});

describe("assignDisplayNames", () => {
  it("truncates names to 12 characters and resolves collisions case-insensitively", () => {
    const assigned = assignDisplayNames([
      { slug: "lab/a", displayName: "An Extremely Long Name" },
      { slug: "lab/b", displayName: "an extremely long name" },
      { slug: "lab/c", displayName: "An Extremely Long Name" },
    ]);
    const names = assigned.map((model) => model.displayName);
    expect(names.every((name) => Array.from(name).length <= 12)).toBe(true);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(3);
    expect(names).toEqual(["An Extremely", "an extremel2", "An Extremel3"]);
  });
});
