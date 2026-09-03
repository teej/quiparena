import type { ArenaDatabase } from "@quiparena/arena";
import { openDb } from "@quiparena/arena";
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

    const gamesResponse = await fetch(`${baseUrl}/api/games`);
    expect(gamesResponse.status).toBe(200);
    const summaries = await gamesResponse.json() as GameSummary[];
    expect(summaries.find((game) => game.id === fixture.archive.game.id)).toMatchObject({
      id: fixture.archive.game.id,
      playerCount: fixture.archive.game.players.length,
      matchupCount: fixture.archive.game.matchups.length,
    });

    const board = await waitFor<LeaderboardResponse>(async () => {
      const response = await fetch(`${baseUrl}/api/leaderboard?population=player`);
      const candidate = await response.json() as LeaderboardResponse;
      return candidate.entries.length > 0 ? candidate : null;
    });
    expect(board.population).toBe("player");
    expect(board.audienceVotingAvailable).toBe(false);
    expect(new Set(board.entries.map((entry) => entry.modelId))).toEqual(
      new Set(fixture.archive.game.players.map((player) => player.modelId)),
    );
    expect(board.entries.every((entry) => entry.games === 1 && entry.matchups > 0)).toBe(true);

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
});
