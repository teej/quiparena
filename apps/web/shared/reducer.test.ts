import type { AnyEvent, Matchup, PlayerRef } from "@quiparena/core";
import { describe, expect, it } from "vitest";

import { createEmptyLiveState, reduceLiveState, replayEvents } from "./reducer.js";

const player: PlayerRef = { id: "p1", name: "Model One", modelId: "openai/model-one" };
const at = "2026-09-02T00:00:00.000Z";

describe("reduceLiveState", () => {
  it("replays a player's prompt, reasoning, draft, and submitted answer", () => {
    const events: AnyEvent[] = [
      { type: "game.created", gameId: "g1", roomCode: "QUIP", at },
      { type: "player.joined", gameId: "g1", player, at },
      { type: "game.started", gameId: "g1", at },
      { type: "round.started", gameId: "g1", round: 1, at },
      { type: "prompt.dealt", gameId: "g1", round: 1, playerId: "p1", prompt: "A prompt", deadlineMs: 10, at },
      { type: "thinking.delta", gameId: "g1", playerId: "p1", text: "One ", at },
      { type: "thinking.delta", gameId: "g1", playerId: "p1", text: "idea", at },
      { type: "answer.draft", gameId: "g1", playerId: "p1", text: "A draft", at },
      { type: "answer.submitted", gameId: "g1", round: 1, playerId: "p1", prompt: "A prompt", answer: "The answer", blank: false, latencyMs: 123, at },
    ];

    const state = replayEvents(events);
    expect(state.roomCode).toBe("QUIP");
    expect(state.round).toBe(1);
    expect(state.players["p1"]).toMatchObject({
      reasoning: "One idea",
      draft: "The answer",
      answer: "The answer",
      activity: "submitted",
    });
  });

  it("tracks a resolved matchup and per-model votes", () => {
    const matchup: Matchup = {
      id: "m1",
      gameId: "g1",
      round: 1,
      index: 0,
      prompt: "A prompt",
      answers: [
        { playerId: "p1", text: "First", blank: false },
        { playerId: "p2", text: "Second", blank: false },
      ],
      votes: [{ voterId: "p3", population: "player", choice: 1 }],
    };
    const state = replayEvents([
      { type: "game.created", gameId: "g1", roomCode: "QUIP", at },
      { type: "matchup.resolved", gameId: "g1", matchup, at },
    ]);
    expect(state.matchups).toEqual([matchup]);
    expect(state.currentVote?.votes).toEqual({ p3: 1 });
    expect(state.currentVote?.resolved?.id).toBe("m1");
  });

  it("resets all prior state when a new game is created", () => {
    const initial = replayEvents([
      { type: "game.created", gameId: "old", roomCode: "OLDG", at },
      { type: "player.joined", gameId: "old", player, at },
    ]);
    const next = reduceLiveState(initial, { type: "game.created", gameId: "new", roomCode: "NEWG", at });
    expect(next.gameId).toBe("new");
    expect(next.playerOrder).toEqual([]);
    expect(next).not.toBe(createEmptyLiveState());
  });

  it("keeps observed standings beside computed final scores", () => {
    const state = replayEvents([
      { type: "game.created", gameId: "g1", roomCode: "QUIP", at },
      { type: "player.joined", gameId: "g1", player, at },
      {
        type: "standings.observed",
        gameId: "g1",
        standings: [{ name: player.name, score: 900, placement: 1 }],
        winner: player.name,
        raw: {},
        at,
      },
      { type: "game.ended", gameId: "g1", finalScores: { p1: 750 }, at },
    ]);
    expect(state.finalScores).toEqual({ p1: 750 });
    expect(state.observedScores).toEqual({ p1: 900 });
    expect(state.observedPlacements).toEqual({ p1: 1 });
  });

  it("records hidden reasoning and retry metadata for the live seat", () => {
    const state = replayEvents([
      { type: "game.created", gameId: "g1", roomCode: "QUIP", audienceEnabled: true, at },
      { type: "player.joined", gameId: "g1", player, at },
      { type: "prompt.dealt", gameId: "g1", round: 1, playerId: "p1", prompt: "A prompt", deadlineMs: 10, at },
      {
        type: "trace.completed",
        gameId: "g1",
        playerId: "p1",
        prompt: "A prompt",
        reasoning: "Provider-only chain of thought",
        reasoningVisible: false,
        answer: "An answer",
        attempts: [
          { kind: "primary", ms: 100, firstTokenMs: null, reasoningTokens: 0, aborted: true },
          { kind: "fast", ms: 80, firstTokenMs: 20, reasoningTokens: 0, aborted: false },
          { kind: "corrective", ms: 70, firstTokenMs: 15, reasoningTokens: 0, aborted: false },
        ],
        at,
      },
    ]);

    expect(state.audienceEnabled).toBe(true);
    expect(state.players["p1"]).toMatchObject({
      reasoning: "",
      reasoningVisible: false,
      attempts: [
        expect.objectContaining({ kind: "primary" }),
        expect.objectContaining({ kind: "fast" }),
        expect.objectContaining({ kind: "corrective" }),
      ],
    });
  });

  it("treats an empty completed trace as no visible reasoning", () => {
    const state = replayEvents([
      { type: "game.created", gameId: "g1", roomCode: "QUIP", at },
      { type: "player.joined", gameId: "g1", player, at },
      {
        type: "trace.completed",
        gameId: "g1",
        playerId: "p1",
        prompt: "A prompt",
        reasoning: "",
        answer: "An answer",
        at,
      },
    ]);
    expect(state.players["p1"]?.reasoningVisible).toBe(false);
  });
});
