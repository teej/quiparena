import type { AnyEvent, GameEvent, PlayerRef } from "@quiparena/core";
import { describe, expect, it } from "vitest";

import { GameAggregator } from "../src/aggregator.js";

const at = "2026-09-02T20:00:00.000Z";

describe("GameAggregator", () => {
  it("recovers the uniquely missing second prompt as a blank at the round boundary", () => {
    const aggregator = new GameAggregator({ gameId: "game-4", expectedPlayerCount: 4 });
    for (const id of ["p1", "p2", "p3", "p4"]) add(aggregator, {
      type: "player.joined", gameId: "game-4", player: { id, name: id, modelId: null }, at,
    });
    for (const [id, prompt] of [["p1", "A"], ["p2", "A"], ["p2", "B"], ["p3", "B"],
      ["p3", "C"], ["p4", "C"], ["p4", "D"]]) add(aggregator, answer(id!, 2, prompt!, id!));
    const emitted = aggregator.ingest({ type: "round.started", gameId: "game-4", round: 3, at });
    const matchups = emitted.filter(event => event.type === "matchup.resolved");
    expect(matchups).toHaveLength(4);
    expect(matchups.find(event => event.matchup.prompt === "D")?.matchup.answers).toEqual([
      { playerId: "p1", text: "", blank: true }, { playerId: "p4", text: "p4", blank: false },
    ]);
  });

  it("does not guess the authors when more than one submission is missing", () => {
    const aggregator = new GameAggregator({ gameId: "game-4", expectedPlayerCount: 4 });
    for (const id of ["p1", "p2", "p3", "p4"]) add(aggregator, {
      type: "player.joined", gameId: "game-4", player: { id, name: id, modelId: null }, at,
    });
    for (const [id, prompt] of [["p1", "A"], ["p2", "A"], ["p3", "B"],
      ["p3", "C"], ["p4", "C"], ["p4", "D"]]) add(aggregator, answer(id!, 2, prompt!, id!));
    const emitted = aggregator.ingest({ type: "round.started", gameId: "game-4", round: 3, at });
    expect(emitted.filter(event => event.type === "matchup.resolved").map(event => event.matchup.prompt)).toEqual(["A", "C"]);
  });

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

  it("retains every vote and pair-specific prompt across Thriplash matchups", () => {
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
    const entries = {
      p1: ["one a", "one b", "one c"],
      p2: ["two a", "two b", "two c"],
      p3: ["three a", "three b", "three c"],
      p4: ["four a", "four b", "four c"],
    } as const;
    for (const player of players) {
      const prompt = player.id === "p1" || player.id === "p2" ? "Pair one" : "Pair two";
      add(aggregator, {
        type: "answer.submitted",
        gameId: "game-4",
        round: 3,
        playerId: player.id,
        prompt,
        answer: [...entries[player.id as keyof typeof entries]],
        blank: false,
        latencyMs: 10,
        at,
      });
    }
    const selections = [
      ["p3", "Pair one", "p1"],
      ["p4", "Pair one", "p2"],
      ["p1", "Pair two", "p3"],
      ["p2", "Pair two", "p4"],
    ] as const;
    for (const [voterId, prompt, selectedId] of selections) {
      const pairIds = prompt === "Pair one" ? ["p1", "p2"] as const : ["p3", "p4"] as const;
      const options = pairIds.map((id) => entries[id].join("\n"));
      const choice = pairIds.indexOf(selectedId as never);
      add(aggregator, voteRequest(voterId, 3, prompt, options));
      add(aggregator, voteCast(voterId, 3, prompt, choice, selectedId, entries[selectedId].join("\n")));
    }

    const thriplash = emitted.find((event) => event.type === "thriplash.resolved");
    expect(thriplash).toMatchObject({
      thriplash: {
        entries: [
          { playerId: "p1", prompt: "Pair one" },
          { playerId: "p2", prompt: "Pair one" },
          { playerId: "p3", prompt: "Pair two" },
          { playerId: "p4", prompt: "Pair two" },
        ],
        votes: [
          { voterId: "p3", choice: 0 },
          { voterId: "p4", choice: 1 },
          { voterId: "p1", choice: 2 },
          { voterId: "p2", choice: 3 },
        ],
      },
    });
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

it("reveals skipped-vote matchups at the next round, never during answer writing", () => {
  const aggregator = new GameAggregator({ gameId: "skip", expectedPlayerCount: 8 });
  aggregator.ingest({ type: "round.started", gameId: "skip", round: 1, at });
  for (const [playerId, answer] of [["1", "Self-checkout"], ["2", ""]]) {
    const emitted = aggregator.ingest({ type: "answer.submitted", gameId: "skip", round: 1,
      playerId: playerId!, answer: answer!, prompt: "Where to cry", blank: answer === "", latencyMs: 1, at });
    expect(emitted.some(e => e.type === "matchup.resolved")).toBe(false);
  }
  const events = aggregator.ingest({ type: "round.started", gameId: "skip", round: 2, at });
  expect(events.map(e => e.type)).toEqual(["matchup.resolved", "round.started"]);
  expect(events[0]).toMatchObject({ matchup: { prompt: "Where to cry", votes: [] } });
  expect(aggregator.ingest({ type: "round.started", gameId: "skip", round: 2, at })).toEqual([]);
});


it.each([false, true])("preserves answer ownership when a safety quip is presented first=%s", (fallbackFirst) => {
  const emitted: GameEvent[] = [];
  const aggregator = new GameAggregator({ gameId: "game-4", expectedPlayerCount: 3, onEvent: event => emitted.push(event) });
  add(aggregator, answer("p1", 2, "Doll says", "I'm a real boy now dad"));
  const fallback = answer("p2", 2, "Doll says", "⁇");
  if (fallback.type !== "answer.submitted") throw new Error("Expected submission");
  add(aggregator, { ...fallback, blank: true });
  const options = fallbackFirst ? ["I DON'T WANT TO GO", "I'M A REAL BOY NOW DAD"] : ["I'M A REAL BOY NOW DAD", "I DON'T WANT TO GO"];
  add(aggregator, voteRequest("p3", 2, "Doll says", options));
  add(aggregator, voteCast("p3", 2, "Doll says", fallbackFirst ? 1 : 0, "0", "I'M A REAL BOY NOW DAD"));
  const resolved = emitted.find(event => event.type === "matchup.resolved");
  expect(resolved?.type).toBe("matchup.resolved");
  if (resolved?.type !== "matchup.resolved") return;
  expect(resolved.matchup.answers.find(answer => answer.playerId === "p1")).toMatchObject({ text: "I'm a real boy now dad", blank: false });
  expect(resolved.matchup.answers.find(answer => answer.playerId === "p2")).toMatchObject({ text: "I DON'T WANT TO GO", blank: true });
  expect(resolved.matchup.answers[resolved.matchup.votes[0]!.choice]!.playerId).toBe("p1");
});

it.each([false, true])("keeps repeated prompts separate even when answer pairs are identical=%s", (identical) => {
  const emitted: GameEvent[] = [];
  const aggregator = new GameAggregator({ gameId: "game-4", expectedPlayerCount: 8, onEvent: event => emitted.push(event) });
  const players = Array.from({ length: 8 }, (_, index) => `p${index + 1}`);
  const prompt = "A surprising thing that DOES impress Shania Twain much";
  const texts = ["A fitted sheet", "A returned shopping cart", identical ? "A fitted sheet" : "A grocery list", identical ? "A returned shopping cart" : "A cassette tape"];
  texts.forEach((text, index) => add(aggregator, answer(players[index]!, 2, prompt, text)));
  for (const pair of [0, 1]) {
    const options = texts.slice(pair * 2, pair * 2 + 2).map(text => text.toUpperCase());
    const voters = players.filter((_, index) => index < pair * 2 || index >= pair * 2 + 2);
    for (const voter of voters) {
      add(aggregator, voteRequest(voter, 2, `${prompt}\nVote for your favorite`, options));
      add(aggregator, voteCast(voter, 2, prompt, 1, "1", options[1]));
    }
  }
  const results = emitted.filter(event => event.type === "matchup.resolved");
  expect(results).toHaveLength(2);
  expect(results.map(event => event.matchup.id)).toEqual(["game-4:r2:m0", "game-4:r2:m1"]);
  expect(results.map(event => event.matchup.answers.map(answer => answer.playerId))).toEqual([["p1", "p2"], ["p3", "p4"]]);
  expect(results.map(event => event.matchup.votes.length)).toEqual([6, 6]);
  expect(results.flatMap(event => event.matchup.votes).every(vote => vote.choice === 1)).toBe(true);
});

it("uses voting eligibility to identify a safety quip's owner among repeated-prompt answers", () => {
  const emitted: GameEvent[] = [];
  const aggregator = new GameAggregator({ gameId: "game-4", expectedPlayerCount: 4, onEvent: event => emitted.push(event) });
  const prompt = "Same prompt";
  const submission = answer("p1", 1, prompt, "⁇");
  if (submission.type !== "answer.submitted") throw new Error("Expected answer");
  add(aggregator, { ...submission, blank: true });
  add(aggregator, answer("p2", 1, prompt, "Real answer"));
  add(aggregator, answer("p3", 1, prompt, "Other answer"));
  add(aggregator, answer("p4", 1, prompt, "Fourth answer"));
  for (const voter of ["p3", "p4"]) {
    add(aggregator, voteRequest(voter, 1, prompt, ["GAME SAFETY QUIP", "REAL ANSWER"]));
    add(aggregator, voteCast(voter, 1, prompt, 0, "0", "GAME SAFETY QUIP"));
  }
  expect(emitted.filter(event => event.type === "matchup.resolved")).toMatchObject([{
    matchup: { answers: [{ playerId: "p1", text: "GAME SAFETY QUIP", blank: true }, { playerId: "p2", text: "Real answer" }] },
  }]);
});

it("resolves a skipped pair sharing a prompt with a voted pair at the round boundary", () => {
  const emitted: GameEvent[] = [];
  const aggregator = new GameAggregator({ gameId: "game-4", expectedPlayerCount: 4, onEvent: event => emitted.push(event) });
  for (const [player, text] of [["p1", "First"], ["p2", "Second"], ["p3", "Third"], ["p4", ""]]) {
    const submission = answer(player!, 1, "Same prompt", text!);
    if (submission.type !== "answer.submitted") throw new Error("Expected answer");
    add(aggregator, { ...submission, blank: !text });
  }
  for (const voter of ["p3", "p4"]) {
    add(aggregator, voteRequest(voter, 1, "Same prompt", ["FIRST", "SECOND"]));
    add(aggregator, voteCast(voter, 1, "Same prompt", 0, "0", "FIRST"));
  }
  expect(emitted.filter(event => event.type === "matchup.resolved")).toHaveLength(1);
  add(aggregator, { type: "round.started", gameId: "game-4", round: 2, at });
  const results = emitted.filter(event => event.type === "matchup.resolved");
  expect(results).toHaveLength(2);
  expect(results[1]!.matchup).toMatchObject({ index: 1, answers: [{ playerId: "p3" }, { playerId: "p4", blank: true }], votes: [] });
});
