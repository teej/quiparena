import { describe, expect, it } from "vitest";

import { createDemoFixture } from "./demo.js";

describe("createDemoFixture", () => {
  it("is deterministic for a seed", () => {
    expect(createDemoFixture(42)).toEqual(createDemoFixture(42));
  });

  it("creates a complete eight-player game with traces", () => {
    const fixture = createDemoFixture(7);
    expect(fixture.archive.game.players).toHaveLength(8);
    expect(fixture.archive.game.matchups).toHaveLength(4);
    expect(fixture.archive.game.thriplash?.entries).toHaveLength(8);
    expect(fixture.archive.game.endedAt).toBeTruthy();
    expect(Object.values(fixture.archive.traces).flat().length).toBeGreaterThan(8);
    expect(createDemoFixture(8).archive.game.id).not.toBe(fixture.archive.game.id);
  });
});
