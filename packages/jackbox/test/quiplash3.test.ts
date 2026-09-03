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
const statesPath = fileURLToPath(new URL("./fixtures/quiplash3-controller-states.json", import.meta.url));
const servers: WebSocketServer[] = [];
const connections: EcastConnection[] = [];

afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("Quiplash3Seat", () => {
  it("sends VIP start, normal answers, runtime vote ids, and retried Thriplash lines", async () => {
    const welcome = await recordedWelcome();
    const states = await controllerStates();
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
      answer: vi.fn()
        .mockResolvedValueOnce("ordinary quip")
        .mockResolvedValueOnce("different quip"),
      answerFinal: vi.fn()
        .mockResolvedValueOnce(["same", "same", "same"])
        .mockResolvedValueOnce(["fresh one", "fresh two", "fresh three"]),
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

    sendEntity(client, pc++, 8, states.vipLobby);
    await waitFor(() => seat.canStart);
    expect(await seat.startIfVip()).toBe(true);
    expect(requests.at(-1)).toMatchObject({
      opcode: "client/send",
      params: { from: 4, to: 1, body: { action: "start" } },
    });

    rejectNextTextAsDuplicate = true;
    sendEntity(client, pc++, 9, states.singleText);
    await waitFor(() => requests.filter((request) => request.opcode === "text/update").length === 2);
    expect(requests.filter((request) => request.opcode === "text/update")[0]).toMatchObject({
      params: { key: "entertext:4", val: "ordinary quip" },
    });
    expect(requests.filter((request) => request.opcode === "text/update")[1]).toMatchObject({
      params: { key: "entertext:4", val: "different quip" },
    });
    expect(player.answer).toHaveBeenNthCalledWith(
      1,
      "The worst mascot",
      expect.objectContaining({ round: 1, gameId: "game-1", maxLength: 45 }),
    );
    expect(player.answer).toHaveBeenNthCalledWith(
      2,
      "The worst mascot",
      expect.objectContaining({
        feedback: "The game rejected that answer because another player submitted the same thing. Give a different one.",
      }),
    );

    sendEntity(client, pc++, 10, states.singleChoice);
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
    expect(events.find((event) => event.type === "vote.requested")).toMatchObject({
      controller: {
        prompt: { text: "Pick the funniest" },
        doneText: { text: "Thanks for voting" },
      },
    });

    rejectNextTextAsDuplicate = true;
    sendEntity(client, pc++, 11, states.thriplash);
    await waitFor(() => requests.filter((request) => request.opcode === "text/update").length === 4);
    const textUpdates = requests.filter((request) => request.opcode === "text/update");
    expect(textUpdates[2]?.params).toMatchObject({ val: "same\nsame\nsame" });
    expect(textUpdates[3]?.params).toMatchObject({ val: "fresh one\nfresh two\nfresh three" });
    expect(player.answerFinal).toHaveBeenNthCalledWith(
      2,
      "Three signs the moon is haunted",
      expect.objectContaining({ maxLength: 45, fieldCount: 3, feedback: expect.any(String) }),
    );

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
      "answer.rejected",
      "answer.submitted",
      "vote.requested",
      "vote.cast",
      "game.ended",
    ]));
    expect(events.filter((event) => event.type === "answer.rejected")).toEqual([
      expect.objectContaining({
        round: 1,
        answer: "ordinary quip",
        reason: "The game rejected that answer because another player submitted the same thing. Give a different one.",
      }),
      expect.objectContaining({ round: 3, answer: ["same", "same", "same"] }),
    ]);
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

  it("projects the latest room/player compatibility aliases with player fields winning", async () => {
    const welcome = await recordedWelcome();
    const requests: ClientFrame[] = [];
    let client: WebSocket | undefined;
    let pc = 2750;
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
    const connection = makeConnection(baseUrl);
    connections.push(connection);
    const player: Player = {
      name: "REC1",
      modelId: null,
      answer: async () => "unused",
      answerFinal: async () => ["unused", "unused", "unused"],
      vote: async () => 0,
    };
    const seat = new Quiplash3Seat(connection, player, { gameId: "aliases", log: () => undefined });
    await seat.connect();
    if (!client) throw new Error("Mock client was not connected");

    sendEntityKey(client, pc++, "text", "bc:room", JSON.stringify({
      state: "Lobby",
      audience: { playerIsVIP: false },
      gameCanStart: true,
      gameIsStarting: false,
      gameFinished: false,
    }), 20);
    sendEntityKey(client, pc++, "text", `bc:customer:${connection.userId}`, JSON.stringify({
      state: "Lobby",
      playerInfo: { avatar: "Purple", username: "REC1" },
      playerIsVIP: true,
      playerCanStartGame: true,
    }), 21);
    await waitFor(() => seat.canStart);
    expect(await seat.startIfVip()).toBe(true);
    expect(requests.at(-1)).toMatchObject({ params: { body: { action: "start" } } });
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
      actions: [{ key: "safetyQuip", text: "Use a safety quip" }],
    });
    await waitFor(() => requests.some((request) => request.opcode === "text/update"));
    expect(requests.find((request) => request.opcode === "text/update")?.params).toMatchObject({ val: "⁇" });
    await waitFor(() => events.some((event) => event.type === "answer.submitted"));
    expect(events.find((event) => event.type === "answer.submitted")).toMatchObject({
      answer: "⁇",
      blank: true,
    });
  });

  it("uses key-or-position choice ids, configurable deadlines, default limits, fieldCount, cancel, and UGC no-op", async () => {
    const welcome = await recordedWelcome();
    const requests: ClientFrame[] = [];
    const logs: Array<{ message: string; raw?: unknown }> = [];
    let client: WebSocket | undefined;
    let pc = 3500;
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
    const player: Player = {
      name: "REC1",
      modelId: null,
      answer: vi.fn(async () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
      answerFinal: vi.fn(async () => ["one", "two", "three"]),
      vote: vi.fn(async () => 0),
    };
    const events: AnyEvent[] = [];
    const connection = makeConnection(baseUrl);
    connections.push(connection);
    const seat = new Quiplash3Seat(connection, player, {
      gameId: "controller-shapes",
      defaultAnswerTimeoutMs: 777,
      defaultThriplashTimeoutMs: 888,
      defaultVoteTimeoutMs: 999,
      timerSafetyMs: 0,
      onEvent: (event) => events.push(event),
      log: (message, raw) => logs.push({ message, raw }),
    });
    await seat.connect();
    if (!client) throw new Error("Mock client was not connected");

    sendEntity(client, pc++, 8, {
      state: "Lobby",
      playerInfo: { avatar: "Purple", username: "REC1" },
      playerIsVIP: true,
      playerCanStartGame: true,
      gameIsStarting: true,
    });
    await waitFor(() => seat.canCancelStart);
    expect(await seat.cancelStartIfVip()).toBe(true);
    expect(requests.at(-1)).toMatchObject({ params: { body: { action: "cancel" } } });

    sendEntity(client, pc++, 9, {
      state: "EnterSingleText",
      round: 1,
      entryId: "default-limit",
      prompt: { text: "Plain text prompt" },
      textKey: "entertext:4",
      entry: 0,
      doneText: { html: "<b>not completion</b>" },
    });
    await waitFor(() => requests.some((request) => request.opcode === "text/update"));
    const normalUpdate = requests.find((request) => request.opcode === "text/update");
    expect(normalUpdate?.params.val).toBe("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS");
    expect(player.answer).toHaveBeenCalledWith(
      "Plain text prompt",
      expect.objectContaining({ maxLength: 45 }),
    );
    expect(events.find((event) => event.type === "prompt.dealt" && event.round === 1)).toMatchObject({
      deadlineMs: 777,
      controller: { prompt: { text: "Plain text prompt" }, doneText: { html: "<b>not completion</b>" } },
    });

    sendEntity(client, pc++, 10, {
      state: "MakeSingleChoice",
      round: 1,
      choiceId: "position-not-index",
      prompt: { html: "<b>Vote now</b>" },
      choices: [{ index: 91, text: "Position wins" }, { key: "other", text: "Other" }],
      chosen: "",
    });
    await waitFor(() => requests.some((request) => body(request).action === "choose"));
    expect(requests.find((request) => body(request).action === "choose")).toMatchObject({
      params: { body: { action: "choose", choice: 0 } },
    });
    expect(events.find((event) => event.type === "vote.requested")).toMatchObject({ deadlineMs: 999 });

    sendEntity(client, pc++, 11, {
      state: "EnterTextList",
      round: 3,
      entryId: "two-fields",
      prompt: { text: "Only two this time" },
      textKey: "entertext:4",
      fieldCount: 2,
      maxLength: 3,
      entries: false,
    });
    await waitFor(() => requests.filter((request) => request.opcode === "text/update").length === 2);
    expect(requests.filter((request) => request.opcode === "text/update")[1]?.params.val).toBe("one\ntwo");
    expect(player.answerFinal).toHaveBeenCalledWith(
      "Only two this time",
      expect.objectContaining({ maxLength: 3, fieldCount: 2 }),
    );
    expect(events.find((event) => event.type === "prompt.dealt" && event.round === 3)).toMatchObject({
      deadlineMs: 888,
    });

    sendEntity(client, pc++, 12, { state: "UGC", validActions: ["add"] });
    await waitFor(() => logs.some((entry) => entry.message.includes("UGC")));
    expect(logs.find((entry) => entry.message === "harness.timing")?.raw).toEqual(expect.objectContaining({
      type: "harness.timing",
      gameId: "controller-shapes",
      playerId: "4",
      state: "Lobby",
      nextState: "EnterSingleText",
      durationMs: expect.any(Number),
    }));
    expect(requests.filter((request) => request.opcode === "client/send").map(body))
      .not.toContainEqual(expect.objectContaining({ action: "add" }));
  });

  it("sends the exact Same Players action from the VIP post-game lobby", async () => {
    const welcome = await recordedWelcome();
    const requests: ClientFrame[] = [];
    let client: WebSocket | undefined;
    let pc = 4000;
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
    const connection = makeConnection(baseUrl);
    connections.push(connection);
    const player: Player = {
      name: "REC1",
      modelId: null,
      answer: async () => "unused",
      answerFinal: async () => ["unused", "unused", "unused"],
      vote: async () => 0,
    };
    const seat = new Quiplash3Seat(connection, player, {
      gameId: "same-players",
      postGameAction: "samePlayers",
      log: () => undefined,
    });
    await seat.connect();
    if (!client) throw new Error("Mock client was not connected");
    sendEntity(client, pc++, 8, {
      state: "Lobby",
      gameFinished: true,
      playerIsVIP: true,
      playerInfo: { avatar: "Purple", username: "REC1" },
    });

    await seat.waitForGameEnd();
    expect(requests.find((request) => body(request).action === "PostGame_Continue")).toMatchObject({
      opcode: "client/send",
      params: { from: 4, to: 1, body: { action: "PostGame_Continue" } },
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

function sendEntityKey(
  socket: WebSocket,
  pc: number,
  opcode: "object" | "text",
  key: string,
  value: unknown,
  version: number,
): void {
  socket.send(JSON.stringify({ pc, opcode, result: { key, val: value, version, from: 1 } }));
}

async function recordedWelcome(): Promise<Record<string, unknown>> {
  const [line] = (await readFile(fixturePath, "utf8")).trim().split("\n");
  if (!line) throw new Error("REC1 fixture is empty");
  return JSON.parse(line) as Record<string, unknown>;
}

async function controllerStates(): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(statesPath, "utf8")) as Record<string, Record<string, unknown>>;
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
