import type { Game, GameEvent, StreamEvent } from "@quiparena/core";
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openDb } from "../src/db/client.js";
import { hasAudienceVotes } from "../src/db/queries.js";
import { answers, events, gamePlayers, games, traces, votes } from "../src/db/schema.js";
import { computeRatings, leaderboard } from "../src/ratings.js";
import { backfillAudienceVotes, inferAudienceVote, Recorder } from "../src/recorder.js";

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
      scores: { p1: 1_250, p2: 0 },
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
      scores: { p1: 0, p2: 2_500 },
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
    scores: { p1: 0, p2: 3_750 },
  },
  finalScores: { p1: 1_250, p2: 6_250 },
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
  { type: "game.ended", gameId: expectedGame.id, at: expectedGame.endedAt! },
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
  it("infers the ZSAX audience unit but accepts a rounded six-player result", () => {
    expect(inferAudienceVote([3, 3], [57, 43])).toEqual({
      choice: 0,
      weight: 1,
      totalVotes: 7,
    });
    expect(inferAudienceVote([4, 2], [67, 33])).toBeUndefined();
    expect(inferAudienceVote([4, 2], [50, 50])).toEqual({
      choice: 1,
      weight: 2,
      totalVotes: 8,
    });
  });

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

  it("round-trips observed standings and reconciles aggregate audience votes by prompt and answers", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    const warnings: string[] = [];
    const recorder = new Recorder(db, { logger: { warn: (message) => warnings.push(message) } });
    const at = "2026-09-02T22:00:00.000Z";
    const matchup = {
      id: "observed-match",
      gameId: "observed-game",
      round: 1 as const,
      index: 0,
      prompt: "A <b>very</b> good prompt",
      answers: [
        { playerId: "p1", text: "Quiet answer", blank: false },
        { playerId: "p2", text: "LOUD ANSWER", blank: false },
      ] as const,
      votes: [{ voterId: "p1", population: "player" as const, choice: 0 }],
    };
    const observedEvents: GameEvent[] = [
      { type: "game.created", gameId: "observed-game", roomCode: "OBSV", at },
      { type: "player.joined", gameId: "observed-game", player: { id: "p1", name: "Alpha", modelId: "lab/alpha" }, at },
      { type: "player.joined", gameId: "observed-game", player: { id: "p2", name: "Beta", modelId: "lab/beta" }, at },
      { type: "matchup.resolved", gameId: "observed-game", matchup, at },
      {
        type: "audience.votes",
        gameId: "observed-game",
        prompt: "A very good prompt Vote for your favorite",
        counts: [4, 0],
        raw: { opcode: "audience/count-group" },
        at,
      },
      {
        type: "matchup.observed",
        gameId: "observed-game",
        prompt: "A very good prompt",
        answers: ["loud answer", "QUIET ANSWER"],
        winner: 0,
        percentages: [80, 20],
        raw: { opcode: "object" },
        at,
      },
      {
        type: "standings.observed",
        gameId: "observed-game",
        standings: [
          { name: "BETA", score: 1234, placement: 1 },
          { name: "alpha", score: 999, placement: 2 },
        ],
        winner: "BETA",
        raw: { opcode: "object" },
        at,
      },
      { type: "game.ended", gameId: "observed-game", at },
    ];
    try {
      for (const event of observedEvents) {
        await recorder.record(event);
        if (event.type === "matchup.resolved") {
          await db.insert(votes).values({
            id: "stale-inferred-audience-vote",
            gameId: "observed-game",
            matchupId: "observed-match",
            voterId: null,
            population: "audience",
            source: "game",
            choice: 0,
            weight: 1,
            inferred: true,
          });
        }
      }

      const [game] = await db.select().from(games);
      expect(game).toMatchObject({
        finalScores: { p1: 200, p2: 900 },
        observedScores: [
          { name: "BETA", score: 1234, placement: 1 },
          { name: "alpha", score: 999, placement: 2 },
        ],
      });
      expect(await db.select({
        playerId: gamePlayers.playerId,
        observedScore: gamePlayers.observedScore,
        observedPlacement: gamePlayers.observedPlacement,
      }).from(gamePlayers)).toEqual(expect.arrayContaining([
        { playerId: "p1", observedScore: 999, observedPlacement: 2 },
        { playerId: "p2", observedScore: 1234, observedPlacement: 1 },
      ]));
      const audienceRows = (await db.select().from(votes)).filter((vote) => vote.population === "audience");
      expect(audienceRows).toHaveLength(1);
      expect(audienceRows[0]).toMatchObject({
        voterId: null,
        population: "audience",
        source: "game",
        choice: 1,
        weight: 4,
        inferred: false,
      });
      await expect(hasAudienceVotes(db)).resolves.toBe(true);
      const recordedGame = await recorder.loadGame("observed-game");
      expect(recordedGame?.finalScores).toEqual({ p1: 200, p2: 900 });
      expect(recordedGame?.observedScores).toEqual({ p1: 999, p2: 1234 });
      expect(warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("player=Alpha computed=200 observed=999"),
        expect.stringContaining("player=Beta computed=900 observed=1234"),
      ]));
    } finally {
      await db.close();
    }
  });

  it("persists and backfills a ZSAX-style inferred audience vote", async () => {
    const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
    const recorder = new Recorder(db);
    const at = "2026-09-03T05:46:00.000Z";
    const gameId = "zsax-inference";
    const players = Array.from({ length: 8 }, (_value, index) => ({
      id: `p${index + 1}`,
      name: `Player ${index + 1}`,
      modelId: `lab/p${index + 1}`,
    }));
    const matchup = {
      id: `${gameId}:r1:m0`,
      gameId,
      round: 1 as const,
      index: 0,
      prompt: "There’s the problem! You’ve got a huge _______ stuck in your sink.",
      answers: [
        { playerId: "p1", text: "MOIST HAUNTED SPAGHETTI", blank: false },
        { playerId: "p2", text: "LIVE RACCOON", blank: false },
      ] as const,
      votes: players.slice(2).map((player, index) => ({
        voterId: player.id,
        population: "player" as const,
        choice: index < 3 ? 0 : 1,
      })),
    };
    try {
      await recorder.record({ type: "game.created", gameId, roomCode: "ZSAX", at });
      for (const player of players) {
        await recorder.record({ type: "player.joined", gameId, player, at });
      }
      await recorder.record({ type: "matchup.resolved", gameId, matchup, at });
      await recorder.record({
        type: "matchup.observed",
        gameId,
        prompt: matchup.prompt,
        answers: [matchup.answers[0].text, matchup.answers[1].text],
        winner: 0,
        percentages: [57, 43],
        raw: { opcode: "object" },
        at,
      });

      const inferredRows = (await db.select().from(votes)).filter((vote) => vote.population === "audience");
      expect(inferredRows).toEqual([
        expect.objectContaining({
          matchupId: matchup.id,
          voterId: null,
          population: "audience",
          source: "game",
          choice: 0,
          weight: 1,
          inferred: true,
        }),
      ]);
      await expect(hasAudienceVotes(db)).resolves.toBe(true);
      const ratings = await computeRatings(db, {
        bootstrapResamples: 0,
        now: new Date("2026-09-03T05:47:00.000Z"),
      });
      expect(ratings.populations.audience.find((entry) => entry.modelSlug === "lab/p1")?.comparisons)
        .toBe(1);
      expect((await leaderboard(db, "audience"))[0]).toMatchObject({
        modelSlug: "lab/p1",
        population: "audience",
        comparisons: 1,
      });

      await db.delete(votes).where(eq(votes.population, "audience"));
      await expect(hasAudienceVotes(db)).resolves.toBe(false);
      await expect(backfillAudienceVotes(db)).resolves.toEqual({
        observedMatchups: 1,
        inferredVotes: 1,
        countedVotes: 0,
      });
      expect((await db.select().from(votes)).filter((vote) => vote.population === "audience"))
        .toEqual([expect.objectContaining({ choice: 0, weight: 1, inferred: true })]);
      await expect(hasAudienceVotes(db)).resolves.toBe(true);
    } finally {
      await db.close();
    }
  });
});
