import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openDb } from "../src/db/client.js";
import {
  answers,
  gamePlayers,
  games,
  matchups,
  models,
  ratingSnapshots,
  votes,
} from "../src/db/schema.js";
import { computeRatings, leaderboard } from "../src/ratings.js";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("Bradley-Terry ratings", () => {
  it("recovers a planted ordering and stores population snapshots with stats", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    const planted = [
      { slug: "lab/dominant", strength: 8 },
      { slug: "lab/strong", strength: 3 },
      { slug: "lab/medium", strength: 1 },
      { slug: "lab/weak", strength: 0.3 },
    ];
    const random = seededRandom(42);
    try {
      await db.insert(models).values(planted.map((model) => ({
        slug: model.slug,
        displayName: model.slug.split("/")[1]!,
        lab: "lab",
        enabled: true,
        config: {},
        ...(model.slug === "lab/dominant" ? { benchState: {
          benched: true,
          gamesRemaining: 7,
          consecutiveSlowGames: 0,
          reason: "3 budget misses",
        } } : {}),
      })));
      await db.insert(games).values({
        id: "rating-game",
        roomCode: "RATE",
        startedAt: new Date("2026-09-02T20:00:00Z"),
        endedAt: new Date("2026-09-02T20:20:00Z"),
        status: "completed",
      });
      await db.insert(gamePlayers).values(planted.map((model, index) => ({
        gameId: "rating-game",
        playerId: `p${index}`,
        name: model.slug.split("/")[1]!,
        modelSlug: model.slug,
        seat: index,
        placement: index + 1,
        totalScore: 4_000 - index * 1_000,
      })));

      let matchupIndex = 0;
      const matchupRows: Array<typeof matchups.$inferInsert> = [];
      const answerRows: Array<typeof answers.$inferInsert> = [];
      const voteRows: Array<typeof votes.$inferInsert> = [];
      for (let left = 0; left < planted.length; left += 1) {
        for (let right = left + 1; right < planted.length; right += 1) {
          const matchupId = `rating-match-${matchupIndex}`;
          matchupRows.push({
            id: matchupId,
            gameId: "rating-game",
            round: matchupIndex % 2 === 0 ? 1 : 2,
            index: matchupIndex,
            prompt: `Pair ${left} versus ${right}`,
          });
          answerRows.push(
            {
              id: `${matchupId}-left`,
              matchupId,
              gameId: "rating-game",
              playerId: `p${left}`,
              answerIndex: 0,
              text: "left",
            },
            {
              id: `${matchupId}-right`,
              matchupId,
              gameId: "rating-game",
              playerId: `p${right}`,
              answerIndex: 1,
              text: "right",
            },
          );
          const leftChance = planted[left]!.strength
            / (planted[left]!.strength + planted[right]!.strength);
          for (let sample = 0; sample < 240; sample += 1) {
            voteRows.push({
              id: `${matchupId}-vote-${sample}`,
              gameId: "rating-game",
              matchupId,
              voterId: null,
              population: sample % 2 === 0 ? "player" : "audience",
              source: sample % 2 === 0 ? "model" : "web",
              choice: random() < leftChance ? 0 : 1,
              weight: sample % 17 === 0 ? 2 : 1,
              createdAt: new Date(1_800_000_000_000 + matchupIndex * 1_000 + sample),
            });
          }
          matchupIndex += 1;
        }
      }
      await db.insert(matchups).values(matchupRows);
      await db.insert(answers).values(answerRows);
      await db.insert(votes).values(voteRows);

      const run = await computeRatings(db, {
        bootstrapResamples: 30,
        rng: seededRandom(7),
        now: new Date("2026-09-02T21:00:00Z"),
      });
      expect(run.populations.blended.map((entry) => entry.modelSlug)).toEqual(
        planted.map((model) => model.slug),
      );
      expect(run.populations.player.map((entry) => entry.modelSlug)).toEqual(
        planted.map((model) => model.slug),
      );
      expect(run.populations.audience.map((entry) => entry.modelSlug)).toEqual(
        planted.map((model) => model.slug),
      );
      expect(run.populations.blended.reduce((sum, entry) => sum + entry.rating, 0) / 4)
        .toBeCloseTo(1_000, 8);

      const [snapshotCount] = await db.select({ value: count() }).from(ratingSnapshots);
      expect(snapshotCount?.value).toBe(3);
      const board = await leaderboard(db);
      expect(board[0]).toMatchObject({
        modelSlug: "lab/dominant",
        displayName: "dominant",
        benched: true,
        benchReason: "3 budget misses",
        stats: { games: 1, wins: 1, avgPlacement: 1, avgPoints: 4_000 },
      });
      // One game is one bootstrap cluster, so this fixture cannot estimate between-game uncertainty.
      expect(board[0]!.lower95).toBeLessThanOrEqual(board[0]!.upper95);
    } finally {
      await db.close();
    }
  });

  it("ignores abandoned game stats but keeps its fully resolved matchup comparisons", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    try {
      await db.insert(models).values([
        { slug: "lab/a", displayName: "A", lab: "lab", enabled: true, config: {} },
        { slug: "lab/b", displayName: "B", lab: "lab", enabled: true, config: {} },
      ]);
      await db.insert(games).values([
        { id: "completed", roomCode: "DONE", startedAt: new Date("2026-09-02T08:00:00Z"), status: "completed" },
        { id: "abandoned", roomCode: "LOST", startedAt: new Date("2026-09-02T09:00:00Z"), status: "abandoned" },
      ]);
      await db.insert(gamePlayers).values([
        { gameId: "completed", playerId: "a1", name: "A", modelSlug: "lab/a", seat: 0, placement: 2, totalScore: 100 },
        { gameId: "completed", playerId: "b1", name: "B", modelSlug: "lab/b", seat: 1, placement: 1, totalScore: 200 },
        { gameId: "abandoned", playerId: "a2", name: "A", modelSlug: "lab/a", seat: 0, placement: 1, totalScore: 9_999 },
        { gameId: "abandoned", playerId: "b2", name: "B", modelSlug: "lab/b", seat: 1, placement: 2, totalScore: 1 },
      ]);
      await db.insert(matchups).values({
        id: "resolved-before-abandon",
        gameId: "abandoned",
        round: 1,
        index: 0,
        prompt: "Still valid",
      });
      await db.insert(answers).values([
        { id: "a-answer", gameId: "abandoned", matchupId: "resolved-before-abandon", playerId: "a2", answerIndex: 0, text: "A" },
        { id: "b-answer", gameId: "abandoned", matchupId: "resolved-before-abandon", playerId: "b2", answerIndex: 1, text: "B" },
      ]);
      await db.insert(votes).values({
        id: "resolved-vote",
        gameId: "abandoned",
        matchupId: "resolved-before-abandon",
        population: "player",
        source: "model",
        choice: 0,
        weight: 1,
      });

      const result = await computeRatings(db, {
        bootstrapResamples: 0,
        now: new Date("2026-09-02T10:00:00Z"),
      });
      const a = result.populations.player.find((entry) => entry.modelSlug === "lab/a")!;
      const b = result.populations.player.find((entry) => entry.modelSlug === "lab/b")!;
      expect(a.rating).toBeGreaterThan(b.rating);
      expect(a.stats).toMatchObject({ games: 1, wins: 0, avgPlacement: 2, avgPoints: 100 });
      expect(b.stats).toMatchObject({ games: 1, wins: 1, avgPlacement: 1, avgPoints: 200 });
    } finally {
      await db.close();
    }
  });

  it("counts one integer outcome per matchup and keeps player and inferred audience votes isolated", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    try {
      await db.insert(models).values([
        { slug: "lab/a", displayName: "A", lab: "lab", enabled: true, config: {} },
        { slug: "lab/b", displayName: "B", lab: "lab", enabled: true, config: {} },
      ]);
      await db.insert(games).values({
        id: "population-outcomes",
        roomCode: "POPS",
        startedAt: new Date("2026-09-02T12:00:00Z"),
        status: "completed",
      });
      await db.insert(gamePlayers).values([
        { gameId: "population-outcomes", playerId: "a", name: "A", modelSlug: "lab/a", seat: 0 },
        { gameId: "population-outcomes", playerId: "b", name: "B", modelSlug: "lab/b", seat: 1 },
      ]);
      await db.insert(matchups).values([0, 1, 2].map((index) => ({
        id: `population-match-${index}`,
        gameId: "population-outcomes",
        round: 1 as const,
        index,
        prompt: `Population matchup ${index}`,
      })));
      await db.insert(answers).values([0, 1, 2].flatMap((index) => ([
        {
          id: `population-answer-${index}-a`, gameId: "population-outcomes",
          matchupId: `population-match-${index}`, playerId: "a", answerIndex: 0, text: "A",
        },
        {
          id: `population-answer-${index}-b`, gameId: "population-outcomes",
          matchupId: `population-match-${index}`, playerId: "b", answerIndex: 1, text: "B",
        },
      ])));
      await db.insert(votes).values([
        // Player A wins, while an inferred audience weight of 2 picks B.
        { id: "m0-player-a", gameId: "population-outcomes", matchupId: "population-match-0", voterId: "p1", population: "player", source: "model", choice: 0, weight: 1 },
        { id: "m0-audience-b", gameId: "population-outcomes", matchupId: "population-match-0", population: "audience", source: "game", choice: 1, weight: 2, inferred: true },
        // Players pick B twice, while an inferred audience weight of 1 picks A.
        { id: "m1-player-b-1", gameId: "population-outcomes", matchupId: "population-match-1", voterId: "p1", population: "player", source: "model", choice: 1, weight: 1 },
        { id: "m1-player-b-2", gameId: "population-outcomes", matchupId: "population-match-1", voterId: "p2", population: "player", source: "model", choice: 1, weight: 1 },
        { id: "m1-audience-a", gameId: "population-outcomes", matchupId: "population-match-1", population: "audience", source: "game", choice: 0, weight: 1, inferred: true },
        // The players tie; the inferred audience weight of 2 breaks the blended result for A.
        { id: "m2-player-a", gameId: "population-outcomes", matchupId: "population-match-2", voterId: "p1", population: "player", source: "model", choice: 0, weight: 1 },
        { id: "m2-player-b", gameId: "population-outcomes", matchupId: "population-match-2", voterId: "p2", population: "player", source: "model", choice: 1, weight: 1 },
        { id: "m2-audience-a", gameId: "population-outcomes", matchupId: "population-match-2", population: "audience", source: "game", choice: 0, weight: 2, inferred: true },
      ]);

      const run = await computeRatings(db, {
        bootstrapResamples: 0,
        blendedWeights: { player: 3, audience: 1 },
        now: new Date("2026-09-02T13:00:00Z"),
      });
      const stats = (population: "player" | "audience" | "blended", slug: string) => (
        run.populations[population].find((entry) => entry.modelSlug === slug)!.stats
      );

      expect(stats("player", "lab/a")).toMatchObject({
        matchupWins: 1, matchupLosses: 1, matchupTies: 1, matchupsPlayed: 3,
        matchupWinRate: 1 / 3,
      });
      expect(stats("audience", "lab/a")).toMatchObject({
        matchupWins: 2, matchupLosses: 1, matchupTies: 0, matchupsPlayed: 3,
        matchupWinRate: 2 / 3,
      });
      expect(stats("blended", "lab/a")).toMatchObject({
        matchupWins: 2, matchupLosses: 1, matchupTies: 0, matchupsPlayed: 3,
        matchupWinRate: 2 / 3,
      });
      expect(stats("player", "lab/b")).toMatchObject({
        matchupWins: 1, matchupLosses: 1, matchupTies: 1, matchupsPlayed: 3,
      });
      expect(stats("audience", "lab/b")).toMatchObject({
        matchupWins: 1, matchupLosses: 2, matchupTies: 0, matchupsPlayed: 3,
      });
      expect(stats("blended", "lab/b")).toMatchObject({
        matchupWins: 1, matchupLosses: 2, matchupTies: 0, matchupsPlayed: 3,
      });

      for (const population of ["player", "audience", "blended"] as const) {
        for (const entry of run.populations[population]) {
          expect([
            entry.stats.matchupWins,
            entry.stats.matchupLosses,
            entry.stats.matchupTies,
            entry.stats.matchupsPlayed,
          ].every(Number.isInteger)).toBe(true);
          expect(entry.stats.matchupsPlayed).toBe(
            entry.stats.matchupWins + entry.stats.matchupLosses + entry.stats.matchupTies,
          );
        }
      }

      expect((await leaderboard(db, "player")).find((entry) => entry.modelSlug === "lab/a")?.stats)
        .toMatchObject({ matchupWins: 1, matchupLosses: 1, matchupTies: 1, matchupsPlayed: 3 });
    } finally {
      await db.close();
    }
  });

  it("uses observed placements for stats and produces audience ratings from aggregate game votes", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    try {
      await db.insert(models).values([
        { slug: "lab/alpha", displayName: "Alpha", lab: "lab", enabled: true, config: {} },
        { slug: "lab/beta", displayName: "Beta", lab: "lab", enabled: true, config: {} },
      ]);
      await db.insert(games).values({
        id: "audience-rating",
        roomCode: "RATE",
        startedAt: new Date("2026-09-02T20:00:00Z"),
        endedAt: new Date("2026-09-02T20:10:00Z"),
        status: "completed",
      });
      await db.insert(gamePlayers).values([
        {
          gameId: "audience-rating", playerId: "a", name: "Alpha", modelSlug: "lab/alpha", seat: 0,
          placement: 1, totalScore: 9_999, observedPlacement: 2, observedScore: 100,
        },
        {
          gameId: "audience-rating", playerId: "b", name: "Beta", modelSlug: "lab/beta", seat: 1,
          placement: 2, totalScore: 1, observedPlacement: 1, observedScore: 200,
        },
      ]);
      await db.insert(matchups).values({
        id: "audience-rating-match", gameId: "audience-rating", round: 1, index: 0, prompt: "Rate it",
      });
      await db.insert(answers).values([
        { id: "audience-rating-a", gameId: "audience-rating", matchupId: "audience-rating-match", playerId: "a", answerIndex: 0, text: "A" },
        { id: "audience-rating-b", gameId: "audience-rating", matchupId: "audience-rating-match", playerId: "b", answerIndex: 1, text: "B" },
      ]);
      await db.insert(votes).values({
        id: "audience-rating-vote",
        gameId: "audience-rating",
        matchupId: "audience-rating-match",
        voterId: null,
        population: "audience",
        source: "game",
        choice: 1,
        weight: 12,
      });

      const run = await computeRatings(db, { bootstrapResamples: 0 });
      expect(run.populations.audience).toHaveLength(2);
      expect(run.populations.audience[0]).toMatchObject({
        modelSlug: "lab/beta",
        comparisons: 12,
        stats: { wins: 1, avgPlacement: 1, avgPoints: 200 },
      });
      expect(run.populations.audience[1]).toMatchObject({
        modelSlug: "lab/alpha",
        stats: { wins: 0, avgPlacement: 2, avgPoints: 100 },
      });
    } finally {
      await db.close();
    }
  });
});
