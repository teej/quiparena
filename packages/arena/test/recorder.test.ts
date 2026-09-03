import type { Game, GameEvent, StreamEvent } from "@quiparena/core";
import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openDb } from "../src/db/client.js";
import { answers, events, traces, votes } from "../src/db/schema.js";
import { Recorder } from "../src/recorder.js";

const expectedGame: Game = {
  id: "game-roundtrip",
  roomCode: "QARP",
  startedAt: "2026-09-02T18:00:02.000Z",
  endedAt: "2026-09-02T18:00:18.000Z",
  players: [
    { id: "p1", name: "Alpha", modelId: "lab/alpha" },
    { id: "p2", name: "Beta", modelId: "lab/beta" },
  ],
  matchups: [
    {
      id: "match-1",
      gameId: "game-roundtrip",
      round: 1,
      index: 0,
      prompt: "The worst yacht name",
      answers: [
        { playerId: "p1", text: "Tax Write-Off", blank: false },
        { playerId: "p2", text: "Oops All Barnacles", blank: false },
      ],
      votes: [{ voterId: "p2", population: "player", choice: 0 }],
      scores: { p1: 1_000, p2: 0 },
    },
    {
      id: "match-2",
      gameId: "game-roundtrip",
      round: 2,
      index: 0,
      prompt: "A bad moon slogan",
      answers: [
        { playerId: "p1", text: "Mostly Cheese-Free", blank: false },
        { playerId: "p2", text: "No Refunds", blank: false },
      ],
      votes: [{ voterId: "p1", population: "player", choice: 1, weight: 2 }],
      scores: { p1: 0, p2: 2_000 },
    },
  ],
  thriplash: {
    gameId: "game-roundtrip",
    prompt: "Three rejected laws",
    entries: [
      { playerId: "p1", lines: ["No Tuesdays", "Shoes vote", "Soup tax"] },
      { playerId: "p2", lines: ["Moon curfew", "Ban beige", "Free geese"] },
    ],
    votes: [{ voterId: "p1", population: "player", choice: 1 }],
    scores: { p1: 0, p2: 3_000 },
  },
  finalScores: { p1: 1_000, p2: 5_000 },
};

const gameEvents: GameEvent[] = [
  { type: "game.created", gameId: expectedGame.id, roomCode: expectedGame.roomCode, at: "2026-09-02T18:00:00.000Z" },
  { type: "player.joined", gameId: expectedGame.id, player: expectedGame.players[0]!, at: "2026-09-02T18:00:00.500Z" },
  { type: "player.joined", gameId: expectedGame.id, player: expectedGame.players[1]!, at: "2026-09-02T18:00:01.000Z" },
  { type: "game.started", gameId: expectedGame.id, at: expectedGame.startedAt },
  { type: "round.started", gameId: expectedGame.id, round: 1, at: "2026-09-02T18:00:03.000Z" },
  { type: "prompt.dealt", gameId: expectedGame.id, round: 1, playerId: "p1", prompt: expectedGame.matchups[0]!.prompt, deadlineMs: 1_000, at: "2026-09-02T18:00:04.000Z" },
  { type: "answer.submitted", gameId: expectedGame.id, round: 1, playerId: "p1", prompt: expectedGame.matchups[0]!.prompt, answer: expectedGame.matchups[0]!.answers[0].text, blank: false, latencyMs: 321, at: "2026-09-02T18:00:05.000Z" },
  { type: "answer.submitted", gameId: expectedGame.id, round: 1, playerId: "p2", prompt: expectedGame.matchups[0]!.prompt, answer: expectedGame.matchups[0]!.answers[1].text, blank: false, latencyMs: 456, at: "2026-09-02T18:00:06.000Z" },
  { type: "matchup.resolved", gameId: expectedGame.id, matchup: expectedGame.matchups[0]!, at: "2026-09-02T18:00:07.000Z" },
  { type: "round.started", gameId: expectedGame.id, round: 2, at: "2026-09-02T18:00:08.000Z" },
  { type: "answer.submitted", gameId: expectedGame.id, round: 2, playerId: "p1", prompt: expectedGame.matchups[1]!.prompt, answer: expectedGame.matchups[1]!.answers[0].text, blank: false, latencyMs: 222, at: "2026-09-02T18:00:09.000Z" },
  { type: "answer.submitted", gameId: expectedGame.id, round: 2, playerId: "p2", prompt: expectedGame.matchups[1]!.prompt, answer: expectedGame.matchups[1]!.answers[1].text, blank: false, latencyMs: 333, at: "2026-09-02T18:00:10.000Z" },
  { type: "matchup.resolved", gameId: expectedGame.id, matchup: expectedGame.matchups[1]!, at: "2026-09-02T18:00:11.000Z" },
  { type: "round.started", gameId: expectedGame.id, round: 3, at: "2026-09-02T18:00:12.000Z" },
  { type: "prompt.dealt", gameId: expectedGame.id, round: 3, playerId: "p2", prompt: expectedGame.thriplash!.prompt, deadlineMs: 2_000, at: "2026-09-02T18:00:13.000Z" },
  { type: "answer.submitted", gameId: expectedGame.id, round: 3, playerId: "p1", prompt: expectedGame.thriplash!.prompt, answer: expectedGame.thriplash!.entries[0]!.lines, blank: false, latencyMs: 555, at: "2026-09-02T18:00:14.000Z" },
  { type: "answer.submitted", gameId: expectedGame.id, round: 3, playerId: "p2", prompt: expectedGame.thriplash!.prompt, answer: expectedGame.thriplash!.entries[1]!.lines, blank: false, latencyMs: 666, at: "2026-09-02T18:00:15.000Z" },
  { type: "thriplash.resolved", gameId: expectedGame.id, thriplash: expectedGame.thriplash!, at: "2026-09-02T18:00:16.000Z" },
  { type: "vote.requested", gameId: expectedGame.id, round: 3, playerId: "p1", prompt: expectedGame.thriplash!.prompt, options: ["A", "B"], deadlineMs: 2_000, at: "2026-09-02T18:00:17.000Z" },
  { type: "game.ended", gameId: expectedGame.id, finalScores: expectedGame.finalScores, at: expectedGame.endedAt! },
];

const traceEvents: StreamEvent[] = [
  {
    type: "trace.completed",
    gameId: expectedGame.id,
    playerId: "p1",
    prompt: expectedGame.matchups[0]!.prompt,
    reasoning: "boats are expensive",
    answer: expectedGame.matchups[0]!.answers[0].text,
    usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.001 },
    at: "2026-09-02T18:00:04.500Z",
  },
  {
    type: "trace.completed",
    gameId: expectedGame.id,
    playerId: "p2",
    prompt: expectedGame.thriplash!.prompt,
    reasoning: "three beats",
    answer: expectedGame.thriplash!.entries[1]!.lines.join("\n"),
    at: "2026-09-02T18:00:13.500Z",
  },
  {
    type: "trace.completed",
    gameId: expectedGame.id,
    playerId: "p1",
    prompt: expectedGame.thriplash!.prompt,
    reasoning: "pick B",
    answer: "1",
    at: "2026-09-02T18:00:17.500Z",
  },
];

describe("Recorder", () => {
  it("round-trips a full game and remains idempotent on replay", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    const recorder = new Recorder(db);
    try {
      for (const event of gameEvents.slice(0, 6)) await recorder.record(event);
      await recorder.record(traceEvents[0]!);
      for (const event of gameEvents.slice(6, 15)) await recorder.record(event);
      await recorder.record(traceEvents[1]!);
      for (const event of gameEvents.slice(15, 19)) await recorder.record(event);
      await recorder.record(gameEvents[19]!);
      await recorder.record(traceEvents[2]!);

      expect(await recorder.loadGame(expectedGame.id)).toEqual(expectedGame);
      const storedTraces = await db.select().from(traces);
      expect(storedTraces.map((trace) => trace.kind)).toEqual(["answer", "final", "vote"]);
      expect(storedTraces[0]).toMatchObject({ modelSlug: "lab/alpha", costUsd: 0.001 });
      expect((await db.select().from(answers)).map((answer) => answer.latencyMs)).toEqual([
        321, 456, 222, 333, 555, 666,
      ]);

      for (const event of gameEvents) await recorder.record(event);
      for (const event of traceEvents) await recorder.record(event);
      const [eventCount] = await db.select({ value: count() }).from(events);
      const [answerCount] = await db.select({ value: count() }).from(answers);
      const [voteCount] = await db.select({ value: count() }).from(votes);
      const [traceCount] = await db.select({ value: count() }).from(traces);
      expect(eventCount?.value).toBe(gameEvents.length);
      expect(answerCount?.value).toBe(6);
      expect(voteCount?.value).toBe(3);
      expect(traceCount?.value).toBe(3);
    } finally {
      await db.close();
    }
  });
});
