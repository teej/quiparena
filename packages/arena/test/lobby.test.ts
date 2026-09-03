import { describe, expect, it } from "vitest";

import { assignDisplayNames, pickNextLobby } from "../src/lobby.js";

const roster = Array.from({ length: 9 }, (_, index) => ({
  slug: `lab/model-${index}`,
  displayName: `Model ${index}`,
  enabled: index !== 8,
}));

describe("pickNextLobby", () => {
  it("keeps top finishers, rotates without duplicates, favors underplayed models, and benches failures", () => {
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
      { modelSlug: "lab/model-6", success: false },
      { modelSlug: "lab/model-6", success: false },
      lastGame,
    ];
    const lobby = pickNextLobby({ roster, lastGame, history, size: 5, keep: 2, rng: () => 0.5 });
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
        { modelSlug: "lab/model-0", success: false },
        { modelSlug: "lab/model-0", success: false },
      ],
      size: 4,
      keep: 0,
      bench: false,
      rng: () => 0,
    });
    expect(lobby).toHaveLength(4);
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
