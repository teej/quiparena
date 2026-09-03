import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";

import type { AnyEvent } from "@quiparena/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { EcastConnection } from "../src/ecast.js";
import type { Player } from "../src/player.js";
import { Quiplash3Seat } from "../src/quiplash3.js";

const fixturePath = fileURLToPath(new URL("./fixtures/rec1-lobby.jsonl", import.meta.url));
const servers: WebSocketServer[] = [];
const connections: EcastConnection[] = [];

afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("Quiplash3Seat", () => {
  it("sends VIP start, normal answers, runtime vote ids, and retried Thriplash lines", async () => {
    const welcome = await recordedWelcome();
    const requests: ClientFrame[] = [];
    let client: WebSocket | undefined;
    let pc = 2000;
    let rejectNextTextAsDuplicate = false;
    const { server, baseUrl } = await mockServer((socket) => {
      client = socket;
      socket.send(JSON.stringify(welcome));
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as ClientFrame;
        requests.push(request);
        if (rejectNextTextAsDuplicate && request.opcode === "text/update") {
          rejectNextTextAsDuplicate = false;
          socket.send(JSON.stringify({
            pc: pc++,
            re: request.seq,
            opcode: "error",
            result: { code: 409, msg: "same answer as someone else" },
          }));
        } else {
          socket.send(JSON.stringify({ pc: pc++, re: request.seq, opcode: "ok", result: {} }));
        }
      });
    });
    servers.push(server);

    const player: Player = {
      name: "REC1",
      modelId: null,
      answer: vi.fn(async () => "ordinary quip"),
      answerFinal: vi.fn(async (): Promise<[string, string, string]> => ["same", "same", "same"]),
      vote: vi.fn(async () => 1),
    };
    const events: AnyEvent[] = [];
    const connection = makeConnection(baseUrl);
    connections.push(connection);
    const seat = new Quiplash3Seat(connection, player, {
      gameId: "game-1",
      defaultAnswerTimeoutMs: 1_000,
      defaultVoteTimeoutMs: 1_000,
      timerSafetyMs: 0,
      postGameAction: "newPlayers",
      onEvent: (event) => events.push(event),
      log: () => undefined,
    });
    await seat.connect();
    if (!client) throw new Error("Mock client was not connected");

    // UNVERIFIED fixtures below model docs/ecast-protocol.md §4; only the initial
    // welcome sent above comes from the real REC1 recording.
    sendEntity(client, pc++, 8, {
      state: "Lobby",
      playerInfo: { avatar: "Purple", username: "REC1" },
      playerIsVIP: true,
      playerCanStartGame: true,
    });
    await waitFor(() => seat.canStart);
    expect(await seat.startIfVip()).toBe(true);
    expect(requests.at(-1)).toMatchObject({
      opcode: "client/send",
      params: { from: 4, to: 1, body: { action: "start" } },
    });

    sendEntity(client, pc++, 9, {
      state: "EnterSingleText",
      round: 1,
      entryId: "answer-1",
      prompt: { html: "<div class='header'>Prompt 1 of 2</div><div>The worst mascot</div>" },
      textKey: "entertext:4",
      maxLength: 45,
      entry: null,
    });
    await waitFor(() => requests.some((request) => request.opcode === "text/update"));
    expect(requests.find((request) => request.opcode === "text/update")).toMatchObject({
      params: { key: "entertext:4", val: "ordinary quip" },
    });
    expect(player.answer).toHaveBeenCalledWith(
      "The worst mascot",
      expect.objectContaining({ round: 1, gameId: "game-1" }),
    );

    sendEntity(client, pc++, 10, {
      state: "MakeSingleChoice",
      round: 2,
      choiceId: "vote-1",
      prompt: { html: "Pick the funniest" },
      choices: [
        { index: 41, html: "First choice" },
        { key: "runtime-right", html: "Second &amp; better" },
      ],
      chosen: null,
    });
    await waitFor(() => requests.some((request) => request.opcode === "client/send"
      && body(request).action === "choose"));
    const voteRequest = requests.find((request) => body(request).action === "choose");
    expect(voteRequest).toMatchObject({
      params: { body: { action: "choose", choice: "runtime-right" } },
    });
    expect(player.vote).toHaveBeenCalledWith(
      "Pick the funniest",
      ["First choice", "Second & better"],
      expect.objectContaining({ round: 2 }),
    );

    rejectNextTextAsDuplicate = true;
    sendEntity(client, pc++, 11, {
      state: "EnterTextList",
      round: 3,
      entryId: "final-1",
      prompt: { html: "Three signs the moon is haunted" },
      textKey: "entertext:4",
      fieldCount: 3,
      maxLength: 45,
      entries: null,
    });
    await waitFor(() => requests.filter((request) => request.opcode === "text/update").length === 3);
    const textUpdates = requests.filter((request) => request.opcode === "text/update");
    expect(textUpdates[1]?.params).toMatchObject({ val: "same\nsame\nsame" });
    expect(textUpdates[2]?.params).toMatchObject({ val: "same !\nsame !!\nsame !!!" });

    sendEntity(client, pc++, 12, {
      state: "Lobby",
      gameFinished: true,
      playerIsVIP: true,
      playerCanStartGame: true,
      playerInfo: { avatar: "Purple", username: "REC1" },
    });
    await waitFor(() => requests.some((request) => body(request).action === "PostGame_NewGame"));
    await seat.waitForGameEnd();

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining([
      "game.created",
      "player.joined",
      "game.started",
      "round.started",
      "prompt.dealt",
      "answer.submitted",
      "vote.requested",
      "vote.cast",
      "game.ended",
    ]));
    expect(events.find((event) => event.type === "vote.cast")).toMatchObject({ choice: 1, round: 2 });
  });

  it("picks an available recorded room character and waits for host propagation", async () => {
    const welcome = structuredClone(await recordedWelcome());
    const result = welcome.result as Record<string, unknown>;
    const entities = result.entities as Record<string, unknown[]>;
    const playerTuple = entities["player:4"]!;
    const playerPayload = playerTuple[1] as { val: Record<string, unknown> };
    playerPayload.val.playerInfo = { username: "REC1" };
    const requests: ClientFrame[] = [];
    let pc = 2500;
    const { server, baseUrl } = await mockServer((socket) => {
      socket.send(JSON.stringify(welcome));
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as ClientFrame;
        requests.push(request);
        socket.send(JSON.stringify({ pc: pc++, re: request.seq, opcode: "ok", result: {} }));
        if (body(request).action === "avatar") {
          sendEntity(socket, pc++, 8, {
            state: "Lobby",
            playerInfo: { avatar: "Yellow", username: "REC1" },
            playerIsVIP: false,
            playerCanStartGame: false,
          });
        }
      });
    });
    servers.push(server);
    const connection = makeConnection(baseUrl);
    connections.push(connection);
    const player: Player = {
      name: "REC1",
      modelId: null,
      answer: async () => "unused",
      answerFinal: async () => ["unused", "unused", "unused"],
      vote: async () => 0,
    };
    const seat = new Quiplash3Seat(connection, player, { gameId: "avatar-game", log: () => undefined });
    await seat.connect();
    await seat.waitUntilAvatarSelected();

    expect(requests[0]).toMatchObject({
      opcode: "client/send",
      params: { from: 4, to: 1, body: { action: "avatar", name: "Yellow" } },
    });
    expect(seat.hasAvatar).toBe(true);
  });

  it("submits a blank fallback when a Player misses the answer deadline", async () => {
    const welcome = await recordedWelcome();
    const requests: ClientFrame[] = [];
    let client: WebSocket | undefined;
    let pc = 3000;
    const { server, baseUrl } = await mockServer((socket) => {
      client = socket;
      socket.send(JSON.stringify(welcome));
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as ClientFrame;
        requests.push(request);
        socket.send(JSON.stringify({ pc: pc++, re: request.seq, opcode: "ok", result: {} }));
      });
    });
    servers.push(server);

    const never = new Promise<string>(() => undefined);
    const player: Player = {
      name: "REC1",
      modelId: null,
      answer: async () => await never,
      answerFinal: async () => ["unused", "unused", "unused"],
      vote: async () => 0,
    };
    const events: AnyEvent[] = [];
    const connection = makeConnection(baseUrl);
    connections.push(connection);
    const seat = new Quiplash3Seat(connection, player, {
      gameId: "deadline-game",
      defaultAnswerTimeoutMs: 25,
      timerSafetyMs: 0,
      onEvent: (event) => events.push(event),
      log: () => undefined,
    });
    await seat.connect();
    if (!client) throw new Error("Mock client was not connected");

    sendEntity(client, pc++, 8, {
      state: "EnterSingleText",
      round: 1,
      entryId: "late-answer",
      prompt: { html: "A very urgent prompt" },
      textKey: "entertext:4",
      maxLength: 45,
      entry: null,
    });
    await waitFor(() => requests.some((request) => request.opcode === "text/update"));
    expect(requests.find((request) => request.opcode === "text/update")?.params).toMatchObject({ val: "" });
    await waitFor(() => events.some((event) => event.type === "answer.submitted"));
    expect(events.find((event) => event.type === "answer.submitted")).toMatchObject({
      answer: "",
      blank: true,
    });
  });
});

interface ClientFrame {
  seq: number;
  opcode: string;
  params: Record<string, unknown>;
}

function body(request: ClientFrame): Record<string, unknown> {
  const candidate = request.params.body;
  return typeof candidate === "object" && candidate !== null
    ? candidate as Record<string, unknown>
    : {};
}

function sendEntity(
  socket: WebSocket,
  pc: number,
  version: number,
  value: Record<string, unknown>,
): void {
  socket.send(JSON.stringify({
    pc,
    opcode: "object",
    result: { key: "player:4", val: value, version, from: 1 },
  }));
}

async function recordedWelcome(): Promise<Record<string, unknown>> {
  const [line] = (await readFile(fixturePath, "utf8")).trim().split("\n");
  if (!line) throw new Error("REC1 fixture is empty");
  return JSON.parse(line) as Record<string, unknown>;
}

function makeConnection(baseUrl: string): EcastConnection {
  return new EcastConnection({
    room: { code: "BEXH", host: "mock.invalid", keepalive: false },
    name: "REC1",
    userId: "c5fff645-b1ad-4be7-8c00-68b1bef40094",
    baseUrl,
    requestTimeoutMs: 500,
    reconnect: { enabled: false },
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
    if (Date.now() > deadline) throw new Error("Timed out waiting for mock Quiplash action");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
