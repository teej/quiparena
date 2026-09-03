import type { ArenaDatabase } from "@quiparena/arena";
import { abandonGame, games, openDb } from "@quiparena/arena";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { ArchivedGame, GameSummary, LeaderboardResponse } from "../shared/types.js";
import { createDemoFixture } from "./demo.js";
import { DbStore } from "./db-store.js";
import { createQuipArenaServer, type QuipArenaServer } from "./server.js";

let db: ArenaDatabase | null = null;
let dbStore: DbStore | null = null;
let service: QuipArenaServer | null = null;

afterEach(async () => {
  if (service) await service.close();
  if (dbStore) await dbStore.close();
  if (db) await db.close();
  service = null;
  dbStore = null;
  db = null;
});

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: "Bearer db-test-token" } });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the database-backed API");
}

describe("DbStore web integration", () => {
  it("round-trips a full ingest through PGlite and refreshes the leaderboard", async () => {
    db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    dbStore = new DbStore(db, {
      ratingsDebounceMs: 0,
      computeRatingsOptions: { bootstrapResamples: 0 },
    });
    service = createQuipArenaServer({
      ingestToken: "db-test-token",
      store: dbStore,
      coalesceMs: 1,
    });
    const address = await service.start(0);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const fixture = createDemoFixture(314_159);
    const socket = await connect(`ws://127.0.0.1:${address.port}/ingest`);
    const nextGame = {
      type: "game.created",
      gameId: "next-game",
      roomCode: "NEXT",
      at: "2026-09-02T23:59:59.000Z",
    } as const;

    socket.send([...fixture.events, nextGame].map((event) => JSON.stringify(event)).join("\n"));

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      const health = await response.json() as { currentGameId: string | null };
      return health.currentGameId === nextGame.gameId ? health : null;
    });

    const archive = await waitFor<ArchivedGame>(async () => {
      const response = await fetch(`${baseUrl}/api/games/${fixture.archive.game.id}`);
      if (!response.ok) return null;
      const candidate = await response.json() as ArchivedGame;
      return candidate.game.endedAt ? candidate : null;
    });
    expect(archive).toEqual(fixture.archive);

    const observedWinner = [...fixture.archive.game.players]
      .sort((left, right) => (fixture.archive.game.finalScores?.[left.id] ?? 0)
        - (fixture.archive.game.finalScores?.[right.id] ?? 0))[0]!;
    await db.update(games).set({ observedScores: [{ name: observedWinner.name, score: 999_999 }] });
    await abandonGame(db, nextGame.gameId);

    const gamesResponse = await fetch(`${baseUrl}/api/games`);
    expect(gamesResponse.status).toBe(200);
    const summaries = await gamesResponse.json() as GameSummary[];
    const expectedCost = Object.values(fixture.archive.traces).flat()
      .reduce((sum, trace) => sum + (trace.usage?.costUsd ?? 0), 0);
    const fixtureSummary = summaries.find((game) => game.id === fixture.archive.game.id);
    expect(fixtureSummary).toMatchObject({
      id: fixture.archive.game.id,
      roomCode: fixture.archive.game.roomCode,
      status: "completed",
      winner: observedWinner,
      playerCount: fixture.archive.game.players.length,
      matchupCount: fixture.archive.game.matchups.length,
    });
    expect(fixtureSummary?.totalCostUsd).toBeCloseTo(expectedCost, 10);
    expect(summaries.find((game) => game.id === nextGame.gameId)).toMatchObject({
      roomCode: "NEXT",
      status: "abandoned",
    });
    const observedArchive = await fetch(`${baseUrl}/api/games/${fixture.archive.game.id}`)
      .then((response) => response.json()) as ArchivedGame;
    expect(observedArchive.game.observedScores?.[observedWinner.id]).toBe(999_999);

    const board = await waitFor<LeaderboardResponse>(async () => {
      const response = await fetch(`${baseUrl}/api/leaderboard?population=player`);
      const candidate = await response.json() as LeaderboardResponse;
      return candidate.entries.length > 0 ? candidate : null;
    });
    expect(board.population).toBe("player");
    expect(board.audienceVotingAvailable).toBe(false);
    expect(board.audienceVotesInferred).toBe(false);
    expect(board.entries.every((entry) => !entry.benched && entry.benchReason === null)).toBe(true);
    expect(new Set(board.entries.map((entry) => entry.modelId))).toEqual(
      new Set(fixture.archive.game.players.map((player) => player.modelId)),
    );
    expect(board.entries.every((entry) => entry.games === 1 && entry.matchupsPlayed > 0)).toBe(true);
    expect(board.entries.every((entry) => (
      Number.isInteger(entry.matchupWins)
      && Number.isInteger(entry.matchupLosses)
      && Number.isInteger(entry.matchupTies)
      && entry.matchupsPlayed === entry.matchupWins + entry.matchupLosses + entry.matchupTies
    ))).toBe(true);

    const unauthorized = await fetch(`${baseUrl}/api/admin/ratings/recompute`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const recomputed = await fetch(`${baseUrl}/api/admin/ratings/recompute`, {
      method: "POST",
      headers: { Authorization: "Bearer db-test-token" },
    });
    expect(recomputed.status).toBe(200);
    expect(await recomputed.json()).toEqual({ ok: true });

    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  it("rehydrates the most recent running game and its trace metadata on startup", async () => {
    db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    dbStore = new DbStore(db);
    const at = "2026-09-02T22:00:00.000Z";
    await dbStore.saveEvent({ type: "game.created", gameId: "running-game", roomCode: "LIVE", at });
    await dbStore.saveEvent({
      type: "player.joined",
      gameId: "running-game",
      player: { id: "p1", name: "Model One", modelId: "test/model-one" },
      at,
    });
    await dbStore.saveEvent({ type: "game.started", gameId: "running-game", at });
    await dbStore.saveEvent({ type: "round.started", gameId: "running-game", round: 1, at });
    await dbStore.saveEvent({
      type: "prompt.dealt",
      gameId: "running-game",
      round: 1,
      playerId: "p1",
      prompt: "Still here?",
      deadlineMs: Date.parse(at) + 30_000,
      at,
    }, {
      p1: [{
        playerId: "p1",
        prompt: "Earlier prompt",
        reasoning: "A retained thought",
        answer: "Yes",
        usage: { inputTokens: 10, outputTokens: 8, reasoningTokens: 4, totalMs: 2_300, firstTokenMs: 410 },
        attempts: [{
          kind: "primary",
          ms: 2_300,
          firstTokenMs: 410,
          reasoningTokens: 4,
          aborted: false,
        }],
        at,
      }],
    });
    await dbStore.close();
    dbStore = new DbStore(db);
    service = createQuipArenaServer({ ingestToken: "db-test-token", store: dbStore });
    await service.start(0);

    expect(service.live.state).toMatchObject({
      gameId: "running-game",
      roomCode: "LIVE",
      round: 1,
      phase: "playing",
      playerOrder: ["p1"],
      traces: {
        p1: [expect.objectContaining({
          prompt: "Earlier prompt",
          usage: expect.objectContaining({ totalMs: 2_300, firstTokenMs: 410 }),
          attempts: [expect.objectContaining({ kind: "primary" })],
        })],
      },
    });
  });
});
