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
        stats: { games: 1, wins: 1, avgPlacement: 1, avgPoints: 4_000 },
      });
      expect(board[0]!.lower95).toBeLessThan(board[0]!.upper95);
    } finally {
      await db.close();
    }
  });
});
