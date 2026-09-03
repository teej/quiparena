import type { Game, StreamEvent } from "@quiparena/core";
import { ScriptedPlayer, type Player } from "@quiparena/jackbox";
import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openDb } from "../src/db/client.js";
import { ratingSnapshots } from "../src/db/schema.js";
import { computeRatings } from "../src/ratings.js";
import type { RosterModel } from "../src/registry.js";
import { WorkerEventBus } from "../src/worker/bus.js";
import { FakeHarness } from "../src/worker/fake-harness.js";
import { runGame, type RunGameOptions } from "../src/worker/game-runner.js";
import { runLoop } from "../src/worker/loop.js";
import { DbSink } from "../src/worker/sinks.js";

function roster(count: number): RosterModel[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `test/model-${index + 1}`,
    displayName: `Model ${index + 1}`,
    lab: "Test",
    released: "2026-09-02",
    reasoning: null,
    temperature: null,
    enabled: true,
    rationale: "Worker test model",
  }));
}

function scripted(entry: RosterModel, name: string): Player {
  const player = new ScriptedPlayer(name);
  return {
    name,
    modelId: entry.slug,
    answer: (prompt, ctx) => player.answer(prompt, ctx),
    answerFinal: (prompt, ctx) => player.answerFinal(prompt, ctx),
    vote: (prompt, options, ctx) => player.vote(prompt, options, ctx),
  };
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("arena worker", () => {
  it("runs the dry pipeline into PGlite and computes a persisted rating snapshot", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    const bus = new WorkerEventBus();
    const dbSink = new DbSink(db);
    bus.addSink(dbSink);
    try {
      const game = await runGame({
        roomCode: "FAKE",
        roster: roster(4),
        bus,
        gameClient: new FakeHarness({ playerCount: 4 }),
        playerFactory: scripted,
        timeoutMs: 10_000,
      });
      const loaded = await dbSink.recorder.loadGame(game.id);
      expect(loaded).toMatchObject({
        id: game.id,
        roomCode: "FAKE",
        players: expect.arrayContaining([
          expect.objectContaining({ modelId: "test/model-1" }),
        ]),
      });
      expect(loaded?.endedAt).toBeTruthy();
      expect(loaded?.matchups).toHaveLength(8);
      expect(loaded?.thriplash?.entries).toHaveLength(4);
      expect(loaded?.finalScores && Object.keys(loaded.finalScores)).toHaveLength(4);

      const ratings = await computeRatings(db, { bootstrapResamples: 0 });
      expect(ratings.populations.player).toHaveLength(4);
      const [snapshots] = await db.select({ value: count() }).from(ratingSnapshots);
      expect(snapshots?.value).toBe(3);
    } finally {
      await db.close();
    }
  });

  it("stops after a completed game exceeds the daily spend cap", async () => {
    const entries = roster(3);
    const bus = new WorkerEventBus();
    const fake = new FakeHarness({ playerCount: 3 });
    const play = async (options: RunGameOptions): Promise<Game> => {
      const gameId = options.gameId ?? "spend-game";
      const trace: StreamEvent = {
        type: "trace.completed",
        gameId,
        playerId: "p1",
        prompt: "costly prompt",
        reasoning: "",
        answer: "answer",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 1.25 },
        at: new Date().toISOString(),
      };
      options.bus?.emit(trace);
      return {
        id: gameId,
        roomCode: options.roomCode,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        players: entries.map((entry, index) => ({ id: `p${index + 1}`, name: entry.displayName, modelId: entry.slug })),
        matchups: [],
        finalScores: { p1: 3, p2: 2, p3: 1 },
      };
    };
    const result = await runLoop({
      roomCode: "FAKE",
      roster: entries,
      players: 3,
      keep: 2,
      bus,
      gameClient: fake,
      runGame: play,
      dailySpendCapUsd: 1,
      logger: quiet,
    });
    expect(result).toMatchObject({ reason: "spend-cap", spentUsd: 1.25 });
    expect(result.games).toHaveLength(1);
  });

  it("keeps two finishers and rotates the other seats across fake games", async () => {
    const entries = roster(8);
    const seen: string[][] = [];
    const result = await runLoop({
      roomCode: "FAKE",
      roster: entries,
      players: 4,
      keep: 2,
      gameClient: new FakeHarness({ playerCount: 4 }),
      playerFactory: scripted,
      rng: () => 0,
      maxGames: 2,
      logger: quiet,
      onGame: (_game, gameRoster) => {
        seen.push(gameRoster.map((entry) => entry.slug));
      },
    });
    expect(result.reason).toBe("max-games");
    expect(seen).toHaveLength(2);
    expect(seen[1]?.slice(0, 2)).toEqual(seen[0]?.slice(0, 2));
    expect(seen[1]?.slice(2)).not.toEqual(expect.arrayContaining(seen[0]?.slice(2) ?? []));
  });

  it("benches a model after failures in consecutive appearances", async () => {
    const entries = roster(6);
    const seen: string[][] = [];
    const play = async (options: RunGameOptions): Promise<Game> => {
      const gameId = options.gameId!;
      const players = options.roster.map((entry, index) => ({
        id: `p${index + 1}`,
        name: entry.displayName,
        modelId: entry.slug,
      }));
      for (const player of players) {
        options.bus?.emit({ type: "player.joined", gameId, player, at: new Date().toISOString() });
      }
      const failing = players.find((player) => player.modelId === "test/model-1");
      if (failing) {
        options.bus?.emit({
          type: "harness.error",
          gameId,
          playerId: failing.id,
          message: "scripted failure",
          at: new Date().toISOString(),
        });
      }
      return {
        id: gameId,
        roomCode: options.roomCode,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        players,
        matchups: [],
        finalScores: Object.fromEntries(players.map((player, index) => [player.id, players.length - index])),
      };
    };
    await runLoop({
      roomCode: "FAKE",
      roster: entries,
      players: 3,
      keep: 1,
      benchFailures: 2,
      gameClient: new FakeHarness({ playerCount: 3 }),
      runGame: play,
      rng: () => 0,
      maxGames: 3,
      logger: quiet,
      onGame: (_game, gameRoster) => seen.push(gameRoster.map((entry) => entry.slug)),
    });
    expect(seen[0]).toContain("test/model-1");
    expect(seen[1]).toContain("test/model-1");
    expect(seen[2]).not.toContain("test/model-1");
  });
});
