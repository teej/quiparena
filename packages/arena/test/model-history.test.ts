import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { jokeResult, modelHistory } from "../src/db/model-history.js";
import { answers, gamePlayers, games, models, thriplashes, votes } from "../src/db/schema.js";

describe("per-joke history results", () => {
  it("distinguishes wins, losses, ties, missing votes, and automatic wins", () => {
    const pair = [{ index: 0, votes: 4, score: 0 }, { index: 1, votes: 2, score: 0 }];
    expect(jokeResult(0, pair)).toEqual({ outcome: "won", votes: 4, totalVotes: 6, automatic: false });
    expect(jokeResult(1, pair)?.outcome).toBe("lost");
    expect(jokeResult(0, pair.map(c => ({ ...c, votes: 3 })))?.outcome).toBe("tied");
    const empty = pair.map(c => ({ ...c, votes: 0 }));
    expect(jokeResult(0, empty)).toBeNull();
    empty[0]!.score = 2000;
    expect(jokeResult(0, empty)).toMatchObject({ outcome: "won", totalVotes: 0, automatic: true });
    expect(jokeResult(1, empty)?.outcome).toBe("lost");
  });

  it("counts weighted votes within the answer's final-round pair, not the entire final", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    try {
      await db.insert(models).values({ slug: "lab/a", displayName: "A", lab: "lab", config: {} });
      await db.insert(games).values({ id: "g", roomCode: "TEST", startedAt: new Date(), status: "completed" });
      await db.insert(gamePlayers).values([0, 1, 2, 3].map(i => ({ gameId: "g", playerId: `p${i}`, name: `P${i}`, modelSlug: i === 0 ? "lab/a" : null })));
      await db.insert(thriplashes).values({ id: "final", gameId: "g", prompt: "fallback" });
      await db.insert(answers).values([0, 1, 2, 3].map(i => ({
        id: `a${i}`, gameId: "g", thriplashId: "final", playerId: `p${i}`, answerIndex: i,
        text: "Answer", prompt: i < 2 ? "First prompt" : "Second prompt", lines: ["One", "Two", "Three"] as [string, string, string],
      })));
      await db.insert(votes).values([1, 5, 80, 20].map((weight, i) => ({
        id: `v${i}`, gameId: "g", thriplashId: "final", choice: i, weight,
        population: "player" as const, source: "model" as const,
      })));
      const history = await modelHistory(db, "lab/a");
      expect(history?.answers[0]).toMatchObject({ prompt: "First prompt", round: 3,
        result: { outcome: "lost", votes: 1, totalVotes: 6, automatic: false } });
      expect((await modelHistory(db, "lab/a", 50))?.answers).toEqual([]);
    } finally { await db.close(); }
  });
});
