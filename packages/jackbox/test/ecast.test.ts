import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { EcastConnection, EntityStore } from "../src/ecast.js";

const fixturePath = fileURLToPath(new URL("./fixtures/rec1-lobby.jsonl", import.meta.url));
const servers: WebSocketServer[] = [];
const connections: EcastConnection[] = [];

afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("EcastConnection", () => {
  it("connects with ecast-v0, applies the real REC1 welcome, and advances entity versions", async () => {
    const frames = await lobbyFrames();
    let requestUrl = "";
    let origin = "";
    let protocol = "";
    let pongReceived = false;
    const { server, baseUrl } = await mockServer((socket, request) => {
      requestUrl = request.url ?? "";
      origin = request.headers.origin ?? "";
      protocol = socket.protocol;
      socket.once("pong", () => {
        pongReceived = true;
      });
      frames.forEach((frame) => socket.send(JSON.stringify(frame)));
      socket.ping("keepalive");
    });
    servers.push(server);
    const connection = makeConnection(baseUrl);
    connections.push(connection);

    const welcome = await connection.connect();
    await waitFor(() => connection.entities.get("room")?.version === 17);
    await waitFor(() => pongReceived);

    expect(welcome).toMatchObject({ id: 4, name: "REC1", reconnect: true, hostId: 1 });
    expect(connection.entities.get<Record<string, unknown>>("player:4")?.value).toMatchObject({
      state: "Lobby",
      playerInfo: { avatar: "Purple", username: "REC1" },
    });
    expect(connection.entities.get("room")?.version).toBe(17);
    expect(connection.pc).toBe(1153);
    expect(requestUrl).toContain("/api/v2/rooms/BEXH/play?");
    expect(new URL(requestUrl, baseUrl).searchParams.get("user-id")).toBe(connection.userId);
    expect(origin).toBe("https://jackbox.tv");
    expect(protocol).toBe("ecast-v0");
  });

  it("correlates replies, ignores stale versions, and records inbound/outbound frames", async () => {
    const frames = await lobbyFrames();
    const received: Record<string, unknown>[] = [];
    const { server, baseUrl } = await mockServer((socket) => {
      socket.send(JSON.stringify(frames[0]));
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { seq: number } & Record<string, unknown>;
        received.push(request);
        socket.send(JSON.stringify({ pc: 1200, re: request.seq, opcode: "ok", result: { accepted: true } }));
      });
    });
    servers.push(server);
    const directory = await mkdtemp(join(tmpdir(), "quiparena-ecast-"));
    const recordFile = join(directory, "frames.jsonl");
    const connection = makeConnection(baseUrl, { recordFile });
    connections.push(connection);
    await connection.connect();

    await expect(connection.request("text/update", { key: "entertext:4", val: "hello" }))
      .resolves.toEqual({ accepted: true });
    expect(received[0]).toMatchObject({ seq: 1, opcode: "text/update" });

    const current = connection.entities.get("room");
    connection.entities.apply("object", { key: "room", val: { state: "Newest" }, version: 20, from: 1 });
    connection.entities.apply("object/update", { key: "room", val: { state: "Stale" }, version: 19, from: 1 });
    expect(current?.version).toBe(16);
    expect(connection.entities.get<Record<string, unknown>>("room")?.value.state).toBe("Newest");

    await connection.flushRecording();
    const records = (await readFile(recordFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.dir)).toEqual(["in", "out", "in"]);
    expect(JSON.parse(records[1].data)).toMatchObject({ opcode: "text/update" });
  });

  it("reconnects immediately with same-page id, secret, device-id, and user-id", async () => {
    const [welcomeFrame] = await lobbyFrames();
    const urls: string[] = [];
    let visits = 0;
    const { server, baseUrl } = await mockServer((socket, request) => {
      urls.push(request.url ?? "");
      visits += 1;
      if (visits === 2) {
        socket.terminate();
        return;
      }
      const frame = structuredClone(welcomeFrame!);
      const result = frame.result as Record<string, unknown>;
      result.reconnect = visits > 1;
      socket.send(JSON.stringify(frame));
      if (visits === 1) setTimeout(() => socket.terminate(), 5);
    });
    servers.push(server);
    const connection = makeConnection(baseUrl, {
      reconnect: { baseDelayMs: 5, maxDelayMs: 5, jitterMs: 0, maxAttempts: 3 },
    });
    connections.push(connection);
    const welcomes: number[] = [];
    const reconnectDelays: number[] = [];
    connection.on("welcome", () => welcomes.push(Date.now()));
    connection.on("reconnecting", (_attempt, delayMs) => reconnectDelays.push(delayMs));
    await connection.connect();
    await waitFor(() => welcomes.length === 2);

    const reconnectUrl = new URL(urls[2]!, baseUrl);
    expect(reconnectUrl.searchParams.get("id")).toBe("4");
    expect(reconnectUrl.searchParams.get("secret")).toBe("31b4e369-00b9-484b-b6bc-9891d16e4f10");
    expect(reconnectUrl.searchParams.get("device-id")).toBe("04320cb4ac.b5f85b09f8161f347abb5e");
    expect(reconnectUrl.searchParams.get("user-id")).toBe(connection.userId);
    expect(reconnectDelays).toEqual([0, 5]);
  });

  it("omits a legacy device-id from page-reload reconnect parameters", async () => {
    const [welcomeFrame] = await lobbyFrames();
    let requestUrl = "";
    const { server, baseUrl } = await mockServer((socket, request) => {
      requestUrl = request.url ?? "";
      socket.send(JSON.stringify(welcomeFrame));
    });
    servers.push(server);
    const connection = makeConnection(baseUrl, {
      credentials: {
        room: "BEXH",
        name: "REC1",
        userId: "c5fff645-b1ad-4be7-8c00-68b1bef40094",
        id: 4,
        secret: "reload-secret",
        deviceId: "legacy-device-id",
      },
    });
    connections.push(connection);
    await connection.connect();

    const url = new URL(requestUrl, baseUrl);
    expect(url.searchParams.get("id")).toBe("4");
    expect(url.searchParams.get("secret")).toBe("reload-secret");
    expect(url.searchParams.has("device-id")).toBe(false);
  });
});

describe("EntityStore", () => {
  it("applies object, text, number, lock, and drop operations", () => {
    const store = new EntityStore();
    store.apply("object", { key: "object", val: { ok: true }, version: 1, from: 1 });
    store.apply("text/update", { key: "text", val: "answer", version: 2, from: 4 });
    store.apply("number", { key: "score", val: 10, version: 3, from: 1 });
    store.apply("lock", { key: "text", from: 1 });

    expect(store.value("object")).toEqual({ ok: true });
    expect(store.value("text")).toBe("answer");
    expect(store.value("score")).toBe(10);
    expect(store.get("text")?.locked).toBe(true);
    store.apply("drop", { key: "text" });
    expect(store.get("text")).toBeUndefined();
  });
});

async function lobbyFrames(): Promise<Record<string, unknown>[]> {
  return (await readFile(fixturePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeConnection(
  baseUrl: string,
  options: Partial<ConstructorParameters<typeof EcastConnection>[0]> = {},
): EcastConnection {
  return new EcastConnection({
    room: { code: "BEXH", host: "mock.invalid", keepalive: false },
    name: "REC1",
    userId: "c5fff645-b1ad-4be7-8c00-68b1bef40094",
    baseUrl,
    requestTimeoutMs: 500,
    reconnect: { enabled: false },
    ...options,
  });
}

async function mockServer(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
): Promise<{ server: WebSocketServer; baseUrl: string }> {
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", onConnection);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port");
  return { server, baseUrl: `ws://127.0.0.1:${address.port}` };
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for mock ecast state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
