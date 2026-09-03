import type { AnyEvent, GameEvent, PlayerRef } from "@quiparena/core";
import { describe, expect, it } from "vitest";

import { GameAggregator } from "../src/aggregator.js";

const at = "2026-09-02T20:00:00.000Z";

describe("GameAggregator", () => {
  it("emits seat-repeated lifecycle events only once", () => {
    const emitted: GameEvent[] = [];
    const aggregator = new GameAggregator({
      gameId: "game-4",
      expectedPlayerCount: 4,
      onEvent: (event) => emitted.push(event),
    });
    const lifecycle: GameEvent[] = [
      { type: "game.created", gameId: "game-4", roomCode: "LIFE", at },
      { type: "game.started", gameId: "game-4", at },
      { type: "round.started", gameId: "game-4", round: 1, at },
      { type: "round.started", gameId: "game-4", round: 2, at },
      { type: "round.started", gameId: "game-4", round: 3, at },
      { type: "game.ended", gameId: "game-4", at },
    ];
    for (const event of lifecycle) {
      for (let seat = 0; seat < 8; seat += 1) add(aggregator, event);
    }

    expect(emitted.filter((event) => event.type === "game.created")).toHaveLength(1);
    expect(emitted.filter((event) => event.type === "game.started")).toHaveLength(1);
    expect(emitted.filter((event) => event.type === "round.started")).toHaveLength(3);
    expect(emitted.filter((event) => event.type === "game.ended")).toHaveLength(1);
  });

  it("matches vote prompts without their suffix and uppercased choices to canonical answers", () => {
    const emitted: GameEvent[] = [];
    const aggregator = new GameAggregator({
      gameId: "game-4",
      expectedPlayerCount: 4,
      onEvent: (event) => emitted.push(event),
    });
    ["p1", "p2", "p3", "p4"].forEach((id) => add(aggregator, {
      type: "player.joined",
      gameId: "game-4",
      player: { id, name: id.toUpperCase(), modelId: null },
      at,
    }));
    add(aggregator, answer("p1", 1, "A tiny profession", "QA1: A tiny horse with a law degree"));
    add(aggregator, answer("p2", 1, "A tiny profession", "QA2: An emotional-support foghorn"));
    const votePrompt = "A tiny profession\nVote for your favorite";
    const options = [
      "QA2: AN EMOTIONAL-SUPPORT FOGHORN",
      "QA1: A TINY HORSE WITH A LAW DEGREE",
    ];
    add(aggregator, voteRequest("p3", 1, votePrompt, options));
    add(aggregator, voteCast("p3", 1, votePrompt, 1, "1", options[1]));
    add(aggregator, voteRequest("p4", 1, votePrompt, options));
    add(aggregator, voteCast("p4", 1, votePrompt, 0, "0", options[0]));

    const matchup = emitted.find((event) => event.type === "matchup.resolved");
    expect(matchup).toMatchObject({
      matchup: {
        prompt: "A tiny profession",
        answers: [
          { playerId: "p2", text: "QA2: An emotional-support foghorn" },
          { playerId: "p1", text: "QA1: A tiny horse with a law degree" },
        ],
        votes: [
          { voterId: "p3", choice: 1 },
          { voterId: "p4", choice: 0 },
        ],
      },
    });
  });

  it("reconstructs a synthetic four-seat game without player-visible result fields", () => {
    const emitted: GameEvent[] = [];
    const aggregator = new GameAggregator({
      gameId: "game-4",
      expectedPlayerCount: 4,
      onEvent: (event) => emitted.push(event),
    });
    const players: PlayerRef[] = ["p1", "p2", "p3", "p4"].map((id) => ({
      id,
      name: id.toUpperCase(),
      modelId: null,
    }));
    players.forEach((player) => add(aggregator, {
      type: "player.joined",
      gameId: "game-4",
      player,
      at,
    }));

    add(aggregator, answer("p1", 1, "A bad mascot", "Tax goose"));
    add(aggregator, answer("p2", 1, "A bad mascot", "Law horse"));
    add(aggregator, {
      ...voteRequest("p3", 1, "A bad mascot", ["Law horse", "Tax goose"]),
      controller: { choices: [{ key: "law", text: "Law horse" }, { key: "tax", text: "Tax goose" }] },
    });
    // A deliberately wrong local index proves that the runtime key is the
    // aggregator's fallback when selected answer text is unavailable.
    add(aggregator, voteCast("p3", 1, "A bad mascot", 1, "law"));
    add(aggregator, voteRequest("p4", 1, "A bad mascot", ["Law horse", "Tax goose"]));
    add(aggregator, voteCast("p4", 1, "A bad mascot", 1, "tax", "Tax goose"));

    const matchupEvent = emitted.find((event) => event.type === "matchup.resolved");
    expect(matchupEvent).toMatchObject({
      matchup: {
        id: "game-4:r1:m0",
        index: 0,
        prompt: "A bad mascot",
        answers: [
          { playerId: "p2", text: "Law horse" },
          { playerId: "p1", text: "Tax goose" },
        ],
        votes: [
          { voterId: "p3", choice: 0, population: "player" },
          { voterId: "p4", choice: 1, population: "player" },
        ],
      },
    });
    if (matchupEvent?.type !== "matchup.resolved") throw new Error("missing matchup");
    expect(matchupEvent.matchup.scores).toBeUndefined();

    const finalEntries = {
      p1: ["one a", "one b", "one c"],
      p2: ["two a", "two b", "two c"],
      p3: ["three a", "three b", "three c"],
      p4: ["four a", "four b", "four c"],
    } as const;
    for (const player of players) {
      add(aggregator, {
        type: "answer.submitted",
        gameId: "game-4",
        round: 3,
        playerId: player.id,
        prompt: "Three moon warnings",
        answer: [...finalEntries[player.id as keyof typeof finalEntries]],
        blank: false,
        latencyMs: 10,
        at,
      });
    }
    const selections = { p1: "p2", p2: "p3", p3: "p4", p4: "p1" } as const;
    for (const voter of players) {
      const selectedId = selections[voter.id as keyof typeof selections];
      const selected = finalEntries[selectedId].join("\n");
      const options = Object.entries(finalEntries)
        .filter(([id]) => id !== voter.id)
        .map(([, lines]) => lines.join("\n"));
      const choice = options.indexOf(selected);
      add(aggregator, voteRequest(voter.id, 3, "Three moon warnings", options));
      add(aggregator, voteCast(voter.id, 3, "Three moon warnings", choice, selectedId, selected));
    }

    const thriplashEvent = emitted.find((event) => event.type === "thriplash.resolved");
    expect(thriplashEvent).toMatchObject({
      thriplash: {
        prompt: "Three moon warnings",
        entries: players.map((player) => ({
          playerId: player.id,
          lines: finalEntries[player.id as keyof typeof finalEntries],
        })),
        votes: [
          { voterId: "p1", choice: 1 },
          { voterId: "p2", choice: 2 },
          { voterId: "p3", choice: 3 },
          { voterId: "p4", choice: 0 },
        ],
      },
    });
    if (thriplashEvent?.type !== "thriplash.resolved") throw new Error("missing Thriplash");
    expect(thriplashEvent.thriplash.scores).toBeUndefined();

    add(aggregator, { type: "game.ended", gameId: "game-4", at });
    expect(emitted.at(-1)).toEqual({ type: "game.ended", gameId: "game-4", at });
    expect(emitted.filter((event) => event.type === "game.ended")).toHaveLength(1);
  });
});

function add(aggregator: GameAggregator, event: AnyEvent): void {
  aggregator.ingest(event);
}

function answer(
  playerId: string,
  round: 1 | 2,
  prompt: string,
  text: string,
): AnyEvent {
  return {
    type: "answer.submitted",
    gameId: "game-4",
    round,
    playerId,
    prompt,
    answer: text,
    blank: false,
    latencyMs: 10,
    at,
  };
}

function voteRequest(
  playerId: string,
  round: 1 | 2 | 3,
  prompt: string,
  options: string[],
): AnyEvent {
  return {
    type: "vote.requested",
    gameId: "game-4",
    round,
    playerId,
    prompt,
    options,
    deadlineMs: 15_000,
    at,
  };
}

function voteCast(
  playerId: string,
  round: 1 | 2 | 3,
  prompt: string,
  choice: number,
  choiceKey: string,
  answerText?: string,
): AnyEvent {
  return {
    type: "vote.cast",
    gameId: "game-4",
    round,
    playerId,
    prompt,
    choice,
    choiceKey,
    ...(answerText === undefined ? {} : { answer: answerText }),
    at,
  };
}
