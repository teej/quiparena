import type { ArenaDatabase } from "@quiparena/arena";
import { openDb, gameAnalytics, traces, votes } from "@quiparena/arena";
import { afterEach, describe, expect, it } from "vitest";

import type { FrontierEntry } from "../shared/frontier.js";
import { createDemoFixture } from "./demo.js";
import { DbStore } from "./db-store.js";
import { buildFrontier, refreshGameAnalytics } from "./frontier.js";
import { InMemoryStore, type Store } from "./store.js";

let db: ArenaDatabase | null = null;
let dbStore: DbStore | null = null;

afterEach(async () => {
  if (dbStore) await dbStore.close();
  if (db) await db.close();
  dbStore = null;
  db = null;
});

async function ingestFixture(store: Store, fixture: ReturnType<typeof createDemoFixture>): Promise<void> {
  for (const event of fixture.archive.events) {
    await store.saveEvent(event, event.type === "game.ended" ? fixture.archive.traces : undefined);
  }
}

/** The fields both stores must agree on; ratings differ by method and are checked separately. */
function costSide(entry: FrontierEntry) {
  const round = (value: number | null) => (value === null ? null : Number(value.toFixed(9)));
  return {
    slug: entry.slug,
    answers: entry.answers,
    matchupWins: entry.matchupWins,
    matchupsPlayed: entry.matchupsPlayed,
    totalCostUsd: round(entry.totalCostUsd),
    costPerAnswerUsd: round(entry.costPerAnswerUsd),
    costPerWinUsd: round(entry.costPerWinUsd),
    avgAnswerMs: round(entry.avgAnswerMs),
    reasoningTokensPerAnswer: round(entry.reasoningTokensPerAnswer),
  };
}

const bySlug = (left: { slug: string }, right: { slug: string }) => left.slug.localeCompare(right.slug);

describe("frontier", () => {
  it("prices a winning joke the same way over PGlite and the in-memory store", async () => {
    db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    dbStore = new DbStore(db, { ratingsDebounceMs: 0, computeRatingsOptions: { bootstrapResamples: 0 } });
    const memory = new InMemoryStore(false);
    const fixture = createDemoFixture(271_828);
    await Promise.all([ingestFixture(dbStore, fixture), ingestFixture(memory, fixture)]);
    await dbStore.recomputeRatings();

    const [fromDb, fromMemory] = await Promise.all([dbStore.frontier("player"), memory.frontier("player")]);
    expect(fromDb.population).toBe("player");
    expect(fromDb.audienceVotingAvailable).toBe(false);
    expect(fromDb.entries).toHaveLength(8);
    expect(fromDb.entries.map(costSide).sort(bySlug)).toEqual(fromMemory.entries.map(costSide).sort(bySlug));

    // Every demo player writes one priced answer, one unpriced final, and unpriced votes.
    const decided = fixture.archive.game.matchups.filter((matchup) => {
      const tally = [0, 0];
      for (const vote of matchup.votes) tally[vote.choice] = (tally[vote.choice] ?? 0) + 1;
      return tally[0] !== tally[1];
    }).length;
    expect(fromDb.entries.reduce((sum, entry) => sum + entry.matchupWins, 0)).toBe(decided);
    for (const entry of fromDb.entries) {
      expect(entry.answers).toBe(1);
      expect(entry.matchupsPlayed).toBe(1);
      expect(entry.games).toBe(1);
      expect(entry.totalCostUsd).toBeGreaterThan(0);
      expect(entry.costPerAnswerUsd).toBeCloseTo(entry.totalCostUsd, 9);
      expect(entry.costPerWinUsd).toBe(entry.matchupWins === 1 ? entry.totalCostUsd : null);
      expect(entry.avgAnswerMs).toBeGreaterThan(0);
      expect(entry.reasoningTokensPerAnswer).toBeGreaterThanOrEqual(18);
      expect(entry.plusMinus).toBeGreaterThanOrEqual(0);
    }
    // Sorted by rating, and the ratings are the leaderboard's ratings.
    const board = await dbStore.leaderboard("player");
    expect(fromDb.entries.map((entry) => entry.rating)).toEqual(board.entries.map((entry) => entry.rating));

    expect((await dbStore.frontier("audience")).entries).toEqual([]);
    expect((await memory.frontier("audience")).entries).toEqual([]);
    expect((await dbStore.frontier("blended")).entries.map(costSide).sort(bySlug))
      .toEqual(fromDb.entries.map(costSide).sort(bySlug));
  });

  it("keeps closed-game aggregates and rating snapshots usable without rereading raw history", async () => {
    db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    dbStore = new DbStore(db, { ratingsDebounceMs: 60_000, computeRatingsOptions: { bootstrapResamples: 0 } });
    await ingestFixture(dbStore, createDemoFixture(271_828));
    await dbStore.recomputeRatings();
    const before = await dbStore.frontier("player");
    const boards = await Promise.all((["standard", "cross-family", "family-balanced"] as const)
      .map(view => dbStore!.leaderboard("player", view)));
    expect(boards.every(board => board.entries.length === 8)).toBe(true);
    const saved = await db.select().from(gameAnalytics);
    expect(saved).toHaveLength(1);
    // Simulates unavailable archival detail, in an isolated in-memory database.
    await db.delete(traces);
    await db.delete(votes);
    await refreshGameAnalytics(db);
    expect(await db.select().from(gameAnalytics)).toEqual(saved);
    expect(await dbStore.frontier("player")).toEqual(before);
    for (const [index, view] of (["standard", "cross-family", "family-balanced"] as const).entries()) {
      expect(await dbStore.leaderboard("player", view)).toEqual(boards[index]);
    }
    // A new store uses persisted results immediately, without a rebuild.
    const reopened = new DbStore(db);
    expect(await reopened.frontier("player")).toEqual(before);
    await reopened.close();
  });

  it("combines latency sums and counts rather than averaging game averages", async () => {
    db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    dbStore = new DbStore(db, { ratingsDebounceMs: 60_000, computeRatingsOptions: { bootstrapResamples: 0 } });
    const first = createDemoFixture(271_828);
    await ingestFixture(dbStore, first);
    const second = JSON.parse(JSON.stringify(first).replaceAll(first.archive.game.id, "second-game")) as typeof first;
    await ingestFixture(dbStore, second);
    const rows = await db.select().from(traces);
    const original = rows.find(row => row.gameId === "second-game" && row.kind === "answer")!;
    await db.insert(traces).values({ ...original, id: "extra-answer", usage: { totalMs: 9_000 }, costUsd: null });
    await dbStore.recomputeRatings();
    const entry = (await dbStore.frontier("player")).entries.find(row => row.slug === original.modelSlug)!;
    expect(entry.answers).toBe(3);
    expect(entry.avgAnswerMs).toBeCloseTo((2 * Number(original.usage!["totalMs"]) + 9_000) / 3);
    const firstTotals = await db.select().from(gameAnalytics);
    await dbStore.recomputeRatings();
    expect(await db.select().from(gameAnalytics)).toEqual(firstTotals);
    expect((await dbStore.frontier("player")).entries.find(row => row.slug === original.modelSlug)).toEqual(entry);
  });

  it("treats unpriced traces as unknown cost and ties as played but not won", () => {
    const models = [
      { slug: "a", displayName: "A", lab: "a", rating: 1100, plusMinus: 20, games: 2 },
      { slug: "b", displayName: "B", lab: "b", rating: 1000, plusMinus: 30, games: 2 },
    ];
    const [a, b] = buildFrontier("player", models, [
      { modelSlug: "a", kind: "answer", costUsd: 0.002, totalMs: 1_000, reasoningTokens: 40 },
      { modelSlug: "a", kind: "vote", costUsd: 0.001, totalMs: null, reasoningTokens: null },
      { modelSlug: "a", kind: "answer", costUsd: null, totalMs: 3_000, reasoningTokens: null },
      { modelSlug: "b", kind: "answer", costUsd: 0, totalMs: null, reasoningTokens: null },
    ], [
      { slugs: ["a", "b"], votes: [{ choice: 0, population: "player", weight: 1 }, { choice: 0, population: "player", weight: 1 }] },
      { slugs: ["b", "a"], votes: [{ choice: 0, population: "player", weight: 1 }, { choice: 1, population: "player", weight: 1 }] },
      { slugs: ["a", "b"], votes: [{ choice: 1, population: "audience", weight: 4 }] },
    ]);
    expect(a).toMatchObject({
      slug: "a", answers: 2, matchupWins: 1, matchupsPlayed: 2, totalCostUsd: 0.003,
      costPerAnswerUsd: 0.0015, costPerWinUsd: 0.003, avgAnswerMs: 2_000, reasoningTokensPerAnswer: 40,
    });
    expect(b).toMatchObject({
      slug: "b", answers: 1, matchupWins: 0, matchupsPlayed: 2, totalCostUsd: 0,
      costPerAnswerUsd: null, costPerWinUsd: null, avgAnswerMs: null, reasoningTokensPerAnswer: null,
    });
    const [, audienceB] = buildFrontier("audience", models, [], [
      { slugs: ["a", "b"], votes: [{ choice: 1, population: "audience", weight: 4 }] },
    ]);
    expect(audienceB).toMatchObject({ slug: "b", matchupWins: 1, matchupsPlayed: 1, costPerWinUsd: null });
  });
});
