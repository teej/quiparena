import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type ClientOptions } from "ws";

import { createQuipArenaServer, type QuipArenaServer } from "./server.js";
import { InMemoryStore } from "./store.js";

let service: QuipArenaServer | null = null;

afterEach(async () => {
  if (service) await service.close();
  service = null;
});

function connect(url: string, options?: ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("/ingest authentication", () => {
  it("drains received events before shutdown completes", async () => {
    const store = new InMemoryStore(false);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const saved: string[] = [];
    vi.spyOn(store, "saveEvent").mockImplementation(async (event) => {
      entered();
      await gate;
      if (!event.gameId) throw new Error("Expected a game event");
      saved.push(event.gameId);
    });
    service = createQuipArenaServer({ ingestToken: "correct-token", store });
    const address = await service.start(0);
    const socket = await connect(`ws://127.0.0.1:${address.port}/ingest`, {
      headers: { Authorization: "Bearer correct-token" },
    });
    socket.send(["g1", "g2"].map((gameId) => JSON.stringify({
      type: "game.created", gameId, roomCode: "TEST", at: "2026-09-02T00:00:00.000Z",
    })).join("\n"));
    await started;
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
    } finally {
      release();
      await closing;
      service = null;
    }
    expect(saved).toEqual(["g1", "g2"]);
  });

  it("rejects a websocket without the shared token", async () => {
    service = createQuipArenaServer({ ingestToken: "correct-token", store: new InMemoryStore(false) });
    const address = await service.start(0);
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ingest`);
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      });
      socket.once("open", () => reject(new Error("Unauthenticated socket opened")));
      socket.once("error", () => undefined);
    });
    expect(status).toBe(401);
  });

  it("accepts a bearer token and ingests JSON lines", async () => {
    service = createQuipArenaServer({ ingestToken: "correct-token", store: new InMemoryStore(false), coalesceMs: 5 });
    const address = await service.start(0);
    const socket = await connect(`ws://127.0.0.1:${address.port}/ingest`, {
      headers: { Authorization: "Bearer correct-token" },
    });
    socket.send(`${JSON.stringify({
      type: "game.created",
      gameId: "g1",
      roomCode: "TEST",
      at: "2026-09-02T00:00:00.000Z",
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.live.state).toMatchObject({ gameId: "g1", roomCode: "TEST" });
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });
});
