import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";

import type { GameEvent } from "@quiparena/core";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { AudienceObserver } from "../src/audience.js";

const fixturePath = fileURLToPath(new URL("./fixtures/audience-TZOQ.jsonl", import.meta.url));
const observers: AudienceObserver[] = [];
const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.allSettled(observers.splice(0).map((observer) => observer.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    for (const socket of server.clients) socket.terminate();
    server.close(() => resolve());
  })));
});

describe("AudienceObserver", () => {
  it("parses every matchup, round scoreboard, final standing, and count bucket in TZOQ", async () => {
    const observer = makeObserver();
    const events: GameEvent[] = [];
    const rows = (await readFile(fixturePath, "utf8")).trim().split("\n");
    for (const line of rows) {
      const row = JSON.parse(line) as { t: number; dir: string; data: string };
      if (row.dir === "in") events.push(...observer.ingestFrame(row.data, new Date(row.t)));
    }

    const matchups = events.filter((event) => event.type === "matchup.observed");
    const scoreboards = events.filter((event) => event.type === "scoreboard.observed");
    const standings = events.filter((event) => event.type === "standings.observed");
    const audienceVotes = events.filter((event) => event.type === "audience.votes");
    expect(events.filter((event) => event.type === "harness.error")).toEqual([]);
    expect(matchups).toHaveLength(20);
    expect(scoreboards).toHaveLength(2);
    expect(standings).toHaveLength(1);
    expect(audienceVotes).toHaveLength(20);
    expect(audienceVotes.every((event) => event.counts[0] === 0 && event.counts[1] === 0)).toBe(true);

    expect(matchups[0]).toMatchObject({
      prompt: "There’s nothing sexier than a tall, beefy boy who knows how to _______",
      answers: ["FOLD A FITTED SHEET WITHOUT CRYING", "NO COMMENT"],
      winner: 0,
      percentages: [100, 0],
    });
    expect(matchups[1]).toMatchObject({ winner: "tie", percentages: [50, 50] });
    expect(matchups[16]).toMatchObject({
      answers: [
        "DOG TAIL THUMPING ON THE FLOOR\nWIFI RECONNECTING AFTER A DROP\nTODDLER TRYING TO PUT ON SHOES",
        "A PUG IN A RAINCOAT\nOLD MEN SLOW DANCING\nTODDLER YELLING I LOVE YOU",
      ],
      winner: 0,
      percentages: [67, 33],
    });
    expect(scoreboards.map((event) => event.round)).toEqual([1, 2]);
    expect(scoreboards[0]?.standings[0]).toEqual({ name: "GPT-5.6 LUNA", score: 2180 });
    expect(scoreboards[1]?.standings[0]).toEqual({ name: "QWEN 3.8 MAX", score: 5790 });
    expect(standings[0]?.winner).toBe("GEMINI PRO");
    expect(standings[0]?.standings).toHaveLength(8);
    expect(standings[0]?.standings.slice(0, 2)).toEqual([
      { name: "GEMINI PRO", score: 9680, placement: 1 },
      { name: "GROK 4.6", score: 8790, placement: 2 },
    ]);
    expect(matchups.every((event) => event.raw !== undefined)).toBe(true);
  });

  it("uses the audience handshake, sends no actions, and reconnects with its welcome secret", async () => {
    const urls: string[] = [];
    let messages = 0;
    let visits = 0;
    const { server, baseUrl } = await mockServer((socket, request) => {
      visits += 1;
      urls.push(request.url ?? "");
      socket.on("message", () => { messages += 1; });
      socket.send(JSON.stringify({
        pc: visits,
        opcode: "client/welcome",
        result: {
          id: 10000000001,
          name: "AUDIENCE",
          secret: "read-only-secret",
          reconnect: visits > 1,
          deviceId: "audience-device",
          entities: {},
        },
      }));
      if (visits === 1) setTimeout(() => socket.terminate(), 5);
    });
    servers.push(server);
    const observer = makeObserver({
      baseUrl,
      reconnect: { baseDelayMs: 1, maxDelayMs: 1, jitterMs: 0 },
    });
    const welcomes: number[] = [];
    observer.on("welcome", () => welcomes.push(Date.now()));
    await observer.connect();
    await waitFor(() => welcomes.length === 2);

    const first = new URL(urls[0]!, baseUrl);
    const second = new URL(urls[1]!, baseUrl);
    expect(first.pathname).toBe("/api/v2/audience/TZOQ/play");
    expect(first.searchParams.get("role")).toBe("audience");
    expect(first.searchParams.get("name")).toBe("AUDIENCE");
    expect(second.searchParams.get("id")).toBe("10000000001");
    expect(second.searchParams.get("secret")).toBe("read-only-secret");
    expect(second.searchParams.get("device-id")).toBe("audience-device");
    expect(second.searchParams.get("user-id")).toBe(first.searchParams.get("user-id"));
    expect(messages).toBe(0);
  });

  it("polls count-group reads during voting and once at the transition without incrementing", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const requestAfterTransition: boolean[] = [];
    let transitioned = false;
    const { server, baseUrl } = await mockServer((socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as Record<string, unknown>;
        requests.push(request);
        requestAfterTransition.push(transitioned);
        socket.send(JSON.stringify({
          pc: 0,
          re: request.seq,
          opcode: "audience/count-group",
          result: { key: "quiplash3 Vote", choices: { left: 2, right: 1 } },
        }));
      });
      socket.send(JSON.stringify({
        pc: 1,
        opcode: "client/welcome",
        result: {
          id: 10000000002,
          name: "AUDIENCE",
          secret: "read-only-secret",
          reconnect: false,
          entities: {
            audiencePlayer: ["object", {
              key: "audiencePlayer",
              val: {
                audience: {
                  state: "MakeSingleChoice",
                  prompt: { html: "Prompt<br><br>Vote for your favorite" },
                  choices: [{ key: "left", html: "A" }, { key: "right", html: "B" }],
                },
              },
            }, { locked: false }],
            "quiplash3 Vote": ["audience/count-group", {
              key: "quiplash3 Vote",
              choices: { left: 0, right: 0 },
            }, { locked: false }],
          },
        },
      }));
      setTimeout(() => {
        transitioned = true;
        socket.send(JSON.stringify({
          pc: 2,
          opcode: "object",
          result: {
            key: "audiencePlayer",
            val: { audience: { state: "Logo" } },
          },
        }));
      }, 25);
    });
    servers.push(server);
    const observer = makeObserver({ baseUrl, countGroupPollMs: 5 });
    const events: GameEvent[] = [];
    observer.on("event", (event) => events.push(event));
    await observer.connect();
    await waitFor(() => requests.length >= 2 && events.some((event) => (
      event.type === "audience.votes" && event.counts[0] === 2 && event.counts[1] === 1
    )));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requestAfterTransition).toContain(false);
    expect(requestAfterTransition).toContain(true);
    expect(requests.every((request) => (
      request.opcode === "audience/count-group/get"
      && JSON.stringify(request.params) === JSON.stringify({ name: "quiplash3 Vote" })
    ))).toBe(true);
    expect(requests.some((request) => String(request.opcode).includes("increment"))).toBe(false);
  });

  it("reports an audience-parse harness error and continues", () => {
    const observer = makeObserver();
    observer.ingestFrame(JSON.stringify({
      opcode: "object",
      result: {
        key: "audiencePlayer",
        val: {
          audience: {
            state: "MakeSingleChoice",
            prompt: { html: "Prompt<br><br>Vote for your favorite" },
            choices: [{ key: "left", html: "A" }, { key: "right", html: "B" }],
          },
        },
      },
    }));
    const events = observer.ingestFrame(JSON.stringify({
      pc: 9,
      opcode: "object",
      result: {
        key: "room",
        val: { textDescriptions: [{ category: "Vote", text: "Localized result text" }] },
      },
    }));
    expect(events).toEqual([expect.objectContaining({
      type: "harness.error",
      reason: "audience-parse",
      stateKey: "pc:9",
    })]);
  });
});

function makeObserver(options: Partial<ConstructorParameters<typeof AudienceObserver>[0]> = {}): AudienceObserver {
  const observer = new AudienceObserver({
    gameId: "fixture-game",
    room: { code: "TZOQ", audienceEnabled: true, audienceHost: "audience.invalid" },
    ...options,
  });
  observers.push(observer);
  return observer;
}

async function mockServer(
  onConnection: (socket: import("ws").WebSocket, request: IncomingMessage) => void,
): Promise<{ server: WebSocketServer; baseUrl: string }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", onConnection);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock audience server did not bind");
  return { server, baseUrl: `ws://127.0.0.1:${address.port}` };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for audience reconnect");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
