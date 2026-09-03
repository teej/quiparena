import type { AddressInfo } from "node:net";

import type { AnyEvent } from "@quiparena/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { IngestSink } from "../src/worker/sinks.js";

let server: WebSocketServer | undefined;

afterEach(async () => {
  if (!server) return;
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for websocket event");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("IngestSink", () => {
  it("authenticates, sends JSON lines, and reconnects after a dropped socket", async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const address = server.address() as AddressInfo;
    const received: AnyEvent[] = [];
    const authorizations: Array<string | undefined> = [];
    let connections = 0;
    let firstClosed!: Promise<void>;

    server.on("connection", (socket, request) => {
      connections += 1;
      authorizations.push(request.headers.authorization);
      socket.on("message", (data) => {
        for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
          received.push(JSON.parse(line) as AnyEvent);
        }
        if (connections === 1) {
          firstClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
          socket.terminate();
        }
      });
    });

    const sink = new IngestSink({
      url: `ws://127.0.0.1:${address.port}`,
      token: "local-token",
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      logger: { warn: () => undefined, error: () => undefined },
    });
    const created: AnyEvent = {
      type: "game.created",
      gameId: "ingest-game",
      roomCode: "TEST",
      at: "2026-09-02T00:00:00.000Z",
    };
    const started: AnyEvent = {
      type: "game.started",
      gameId: "ingest-game",
      at: "2026-09-02T00:00:01.000Z",
    };
    try {
      sink.consume(created);
      await waitFor(() => received.length === 1);
      await firstClosed;
      await waitFor(() => !sink.connected);
      sink.consume(started);
      await waitFor(() => received.length === 2 && connections === 2);
      await sink.flush();
      expect(received).toEqual([created, started]);
      expect(authorizations).toEqual(["Bearer local-token", "Bearer local-token"]);
    } finally {
      await sink.close();
    }
  });
});
