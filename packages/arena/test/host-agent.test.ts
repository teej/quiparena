import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDb } from "../src/db/client.js";
import { gamePlayers, games } from "../src/db/schema.js";
import {
  runHostAgent,
  statusFilePath,
  writeRoomFileIfChanged,
} from "../src/host-agent/host-agent.js";
import { parseVisionOutput, readRoomCode } from "../src/host-agent/read-code.js";
import {
  captureFinalScores,
  parseFinalScores,
} from "../src/host-agent/read-scores.js";

const SAMPLE_SCREENSHOT = "/private/tmp/claude-501/-Users-teej-Code-quiparena/5101469a-c685-4910-b7fe-7b570b36f4e8/scratchpad/screen_small.png";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "quiparena-host-agent-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("parseVisionOutput", () => {
  it("accepts only a bare uppercase four-letter code and a known state", () => {
    expect(parseVisionOutput("BEXH\nlobby")).toEqual({ code: "BEXH", screenState: "lobby" });
    expect(parseVisionOutput("NONE\nmenu")).toEqual({ code: null, screenState: "menu" });
    expect(parseVisionOutput("bexh\nlobby")).toEqual({ code: null, screenState: "lobby" });
    expect(parseVisionOutput("CODE: BEXH\nsomething else")).toEqual({
      code: null,
      screenState: "unknown",
    });
  });

  it("validates mocked model output and confirms only Quiplash 3 rooms", async () => {
    const directory = await temporaryDirectory();
    const image = join(directory, "mock.png");
    await writeFile(image, "mock image");
    const lookup = vi.fn(async () => ({ code: "BEXH", host: "ecast.test", appTag: "quiplash3" }));
    const generate = vi.fn(async () => "BEXH\nlobby");

    await expect(readRoomCode(image, { generate, lookup })).resolves.toEqual({
      code: "BEXH",
      confirmed: true,
      screenState: "lobby",
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith("BEXH");

    await expect(readRoomCode(image, {
      generate,
      lookup: async () => ({ code: "BEXH", host: "ecast.test", appTag: "drawful2" }),
    })).resolves.toMatchObject({ code: "BEXH", confirmed: false });
  });
});

describe("writeRoomFileIfChanged", () => {
  it("atomically writes a changed code and leaves an identical code alone", async () => {
    const directory = await temporaryDirectory();
    const roomFile = join(directory, "nested", "room-code");

    await expect(writeRoomFileIfChanged(roomFile, "BEXH")).resolves.toBe(true);
    await expect(readFile(roomFile, "utf8")).resolves.toBe("BEXH\n");
    await expect(writeRoomFileIfChanged(roomFile, "BEXH")).resolves.toBe(false);
    await expect(writeRoomFileIfChanged(roomFile, "bad")).rejects.toThrow("Invalid room code");
  });
});

describe("final score capture", () => {
  it("validates every model-returned name and stores observed scores beside computed scores", async () => {
    expect(parseFinalScores(
      '```json\n[{"name":"alpha","score":1250},{"name":"Beta","score":900}]\n```',
      ["Alpha", "Beta"],
    )).toEqual([{ name: "Alpha", score: 1_250 }, { name: "Beta", score: 900 }]);
    expect(() => parseFinalScores('[{"name":"Stranger","score":1}]', ["Alpha"]))
      .toThrow("unknown player name");

    const directory = await temporaryDirectory();
    const image = join(directory, "scores.png");
    await writeFile(image, "mock image");
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    const logger = { info: vi.fn(), warn: vi.fn() };
    try {
      await db.insert(games).values({
        id: "score-game",
        roomCode: "SCRS",
        startedAt: new Date("2026-09-02T10:00:00Z"),
        status: "completed",
        finalScores: { p1: 1_250, p2: 800 },
      });
      await db.insert(gamePlayers).values([
        { gameId: "score-game", playerId: "p1", name: "Alpha", seat: 0, placement: 1, totalScore: 1_250 },
        { gameId: "score-game", playerId: "p2", name: "Beta", seat: 1, placement: 2, totalScore: 800 },
      ]);
      const generate = vi.fn(async (_image: Uint8Array, prompt: string) => {
        expect(prompt).toContain('"Alpha", "Beta"');
        return '[{"name":"Alpha","score":1250},{"name":"Beta","score":900}]';
      });

      await expect(captureFinalScores(db, "score-game", image, { generate, logger }))
        .resolves.toEqual({
          scores: [{ name: "Alpha", score: 1_250 }, { name: "Beta", score: 900 }],
          mismatches: [{ name: "Beta", computed: 800, observed: 900 }],
        });
      expect((await db.select().from(games))[0]?.observedScores).toEqual([
        { name: "Alpha", score: 1_250 },
        { name: "Beta", score: 900 },
      ]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Beta computed=800 observed=900"));
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!process.env["OPENROUTER_API_KEY"])("host-agent --image integration", () => {
  it("reads and confirms BEXH from the real lobby screenshot", async () => {
    const directory = await temporaryDirectory();
    const roomFile = join(directory, "room-code");
    const result = await runHostAgent({
      roomFile,
      once: true,
      image: SAMPLE_SCREENSHOT,
      apiKey: process.env["OPENROUTER_API_KEY"],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result).toMatchObject({ code: "BEXH", confirmed: true, screenState: "lobby" });
    await expect(readFile(roomFile, "utf8")).resolves.toBe("BEXH\n");
    await expect(readFile(statusFilePath(roomFile), "utf8")).resolves.toContain('"code": "BEXH"');
    await expect(readFile(statusFilePath(roomFile), "utf8")).resolves.toContain('"confirmed": true');
  }, 30_000);
});
