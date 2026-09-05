import { describe, expect, it, vi } from "vitest";
import { GameContext } from "../src/worker/game-context.js";
import type { Player } from "@quiparena/jackbox";

const at = "2026-09-05T18:00:00Z";
describe("player-visible game context", () => {
  it("includes own answers, withholds opponents' unrevealed answers, and masks voting without changing choices", async () => {
    const context = new GameContext("g");
    for (const [id, name, modelId] of [["1", "GPT-6 Astra", "openai/astra"], ["2", "Fable", "anthropic/fable"]]) {
      context.consume({ type: "player.joined", gameId: "g", player: { id: id!, name: name!, modelId: modelId! }, at });
    }
    context.consume({ type: "answer.submitted", gameId: "g", playerId: "2", prompt: "secret prompt", answer: "secret answer", round: 1, blank: false, latencyMs: 1, at });
    context.consume({ type: "answer.submitted", gameId: "g", playerId: "1", prompt: "my prompt", answer: "my answer", round: 1, blank: false, latencyMs: 1, at });
    expect(context.snapshot("GPT-6 Astra", false)).toContain("my answer");
    expect(context.snapshot("GPT-6 Astra", false)).not.toContain("secret");
    context.consume({ type: "matchup.resolved", gameId: "g", at, matchup: {
      id: "m", gameId: "g", prompt: "revealed", round: 1, index: 0,
      answers: [{ playerId: "1", text: "Fable's hat", blank: false }, { playerId: "2", text: "a shoe", blank: false }],
      votes: [{ voterId: "3", population: "player", choice: 0 }],
    }});
    const vote = vi.fn(async () => 1);
    const answer = vi.fn(async () => "answer");
    const player: Player = { name: "GPT-6 Astra", modelId: "openai/astra", answer, vote, answerFinal: async () => ["a", "b", "c"] };
    const wrapped = context.wrap(player);
    const ctx = { gameId: "g", round: 2 as const, deadlineMs: Date.now() + 1000, maxLength: 45 };
    await wrapped.answer("new prompt", ctx);
    expect(JSON.stringify(answer.mock.calls)).toContain("GPT-6 Astra");
    expect(await wrapped.vote("Roast Fable", ["GPT-6 Astra", "FABLE"], { ...ctx, feedback: "Fable" })).toBe(1);
    const request = JSON.stringify(vote.mock.calls);
    expect(request).toContain("Player 1");
    expect(request).not.toMatch(/Fable|GPT-6 Astra|openai\/astra|anthropic\/fable/i);
    expect(request).not.toContain("secret");
    context.consume({ type: "player.joined", gameId: "other", player: { id: "9", name: "Other", modelId: null }, at });
    expect(context.snapshot(player.name, false)).not.toContain("Other");
  });
});
