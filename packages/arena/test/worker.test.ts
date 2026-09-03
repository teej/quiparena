import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnyEvent, Game, StreamEvent } from "@quiparena/core";
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
import { loadLobbyHistoryFromApi, runLoop } from "../src/worker/loop.js";
import type { CreateAudienceObserverOptions, GameClient } from "../src/worker/seat.js";
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

  it("starts an audience observer, waits for its final standings, and uses them for the returned game", async () => {
    class ObservedHarness extends FakeHarness {
      connected = false;
      closed = false;

      createAudienceObserver(options: CreateAudienceObserverOptions) {
        return {
          connect: async () => { this.connected = true; },
          waitForFinalStandings: async () => {
            options.onEvent({
              type: "standings.observed",
              gameId: options.gameId,
              standings: [
                { name: "Model 2", score: 999, placement: 1 },
                { name: "Model 1", score: 500, placement: 2 },
                { name: "Model 3", score: 0, placement: 3 },
              ],
              winner: "Model 2",
              raw: {},
              at: new Date().toISOString(),
            });
          },
          close: async () => { this.closed = true; },
        };
      }
    }

    const harness = new ObservedHarness({ playerCount: 3 });
    const game = await runGame({
      roomCode: "FAKE",
      roster: roster(3),
      gameClient: harness,
      playerFactory: scripted,
      timeoutMs: 10_000,
    });
    expect(harness.connected).toBe(true);
    expect(harness.closed).toBe(true);
    expect(game.observedScores).toEqual({ "2": 500, "3": 999, "4": 0 });
    expect(game.observedPlacements).toEqual({ "2": 2, "3": 1, "4": 3 });
  });

  it("publishes one lifecycle stream while preserving seat-scoped player ids", async () => {
    const source = new FakeHarness({ playerCount: 4 });
    const duplicated: GameClient = {
      lookupRoom: (roomCode) => source.lookupRoom(roomCode),
      createSeat: (options) => source.createSeat({
        ...options,
        onEvent: (event) => {
          if (event.type === "matchup.resolved" || event.type === "thriplash.resolved") return;
          const lifecycle = event.type === "game.created"
            || event.type === "game.started"
            || event.type === "round.started"
            || event.type === "game.ended";
          for (let copy = 0; copy < (lifecycle ? 4 : 1); copy += 1) options.onEvent(event);
        },
      }),
    };
    const bus = new WorkerEventBus();
    const emitted: AnyEvent[] = [];
    bus.on((event) => emitted.push(event));
    await runGame({
      roomCode: "FAKE",
      roster: roster(4),
      bus,
      gameClient: duplicated,
      playerFactory: scripted,
      timeoutMs: 10_000,
    });

    expect(emitted.filter((event) => event.type === "game.created")).toHaveLength(1);
    expect(emitted.filter((event) => event.type === "game.started")).toHaveLength(1);
    expect(emitted.filter((event) => event.type === "round.started")).toHaveLength(3);
    expect(emitted.filter((event) => event.type === "game.ended")).toHaveLength(1);
    expect(new Set(emitted.filter((event) => event.type === "prompt.dealt").map((event) => event.playerId)))
      .toEqual(new Set(["2", "3", "4", "5"]));
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

  it("honors a graceful stop request after the current game", async () => {
    let stopRequested = false;
    const result = await runLoop({
      roomCode: "FAKE",
      roster: roster(4),
      players: 4,
      keep: 2,
      gameClient: new FakeHarness({ playerCount: 4 }),
      playerFactory: scripted,
      stopRequested: () => stopRequested,
      logger: quiet,
      onGame: () => { stopRequested = true; },
    });
    expect(result.reason).toBe("graceful-stop");
    expect(result.games).toHaveLength(1);
  });

  it("polls a stop file at the game boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quiparena-loop-stop-"));
    const stopFile = join(directory, "loop.stop");
    try {
      const result = await runLoop({
        roomCode: "FAKE",
        roster: roster(4),
        players: 4,
        keep: 2,
        gameClient: new FakeHarness({ playerCount: 4 }),
        playerFactory: scripted,
        stopFile,
        logger: quiet,
        onGame: async () => { await writeFile(stopFile, "stop\n"); },
      });
      expect(result.reason).toBe("graceful-stop");
      expect(result.games).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it("seeds keepers from the previous process and logs every selection rationale", async () => {
    const entries = roster(6);
    const selected: string[][] = [];
    const messages: string[] = [];
    const play = async (options: RunGameOptions): Promise<Game> => ({
      id: options.gameId!,
      roomCode: options.roomCode,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      players: options.roster.map((entry, index) => ({
        id: `new-${index}`,
        name: entry.displayName,
        modelId: entry.slug,
      })),
      matchups: [],
      finalScores: {},
    });
    await runLoop({
      roomCode: "FAKE",
      roster: entries,
      players: 3,
      keep: 2,
      seedHistory: [{
        id: "previous-process",
        players: [
          { id: "old-1", modelId: "test/model-1", placement: 3, totalScore: 100 },
          { id: "old-2", modelId: "test/model-2", placement: 1, totalScore: 300 },
          { id: "old-3", modelId: "test/model-3", placement: 2, totalScore: 200 },
        ],
        finalScores: { "old-1": 100, "old-2": 300, "old-3": 200 },
      }],
      gameClient: new FakeHarness({ playerCount: 3 }),
      runGame: play,
      rng: () => 0,
      maxGames: 1,
      logger: {
        info: (message) => messages.push(message),
        warn: (message) => messages.push(message),
        error: (message) => messages.push(message),
      },
      onGame: (_game, gameRoster) => selected.push(gameRoster.map((entry) => entry.slug)),
    });
    expect(selected[0]?.slice(0, 2)).toEqual(["test/model-2", "test/model-3"]);
    expect(messages.filter((message) => message.includes("[quiparena/worker] pick "))).toHaveLength(3);
    expect(messages.some((message) => message.includes("keeper placement=1 points=300"))).toBe(true);
    expect(messages.some((message) => message.includes("rotation games=0 weight=1 sat-out-last-game"))).toBe(true);
  });

  it("loads completed history from the ingest web archive API", async () => {
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/games")) {
        return Response.json([
          { id: "running", startedAt: "2026-09-02T11:00:00Z", endedAt: null },
          { id: "done", startedAt: "2026-09-02T10:00:00Z", endedAt: "2026-09-02T10:20:00Z" },
        ]);
      }
      return Response.json({
        game: {
          id: "done",
          roomCode: "DONE",
          startedAt: "2026-09-02T10:00:00Z",
          players: [
            { id: "p1", name: "One", modelId: "test/model-1" },
            { id: "p2", name: "Two", modelId: "test/model-2" },
          ],
          matchups: [{
            id: "old-matchup",
            gameId: "done",
            round: 1,
            index: 0,
            prompt: "Old prompt",
            answers: [
              { playerId: "p1", text: "One", blank: false },
              { playerId: "p2", text: "Two", blank: false },
            ],
            votes: [{ voterId: "v1", population: "player", choice: 0 }],
          }],
        },
      });
    };
    await expect(loadLobbyHistoryFromApi("ws://127.0.0.1:8787/ingest", fetch)).resolves.toEqual([{
      id: "done",
      status: "completed",
      players: [{
        id: "p1",
        playerId: "p1",
        modelId: "test/model-1",
        modelSlug: "test/model-1",
        placement: 1,
        totalScore: 1_250,
      }, {
        id: "p2",
        playerId: "p2",
        modelId: "test/model-2",
        modelSlug: "test/model-2",
        placement: 2,
        totalScore: 0,
      }],
      finalScores: { p1: 1_250, p2: 0 },
    }]);
  });
});
