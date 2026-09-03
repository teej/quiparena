import type { StreamEvent } from "@quiparena/core";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ModelPlayer, type ModelPlayerLogger } from "../src/model-player.js";
import { parseFinalAnswers, parseVote, sanitizeAnswer } from "../src/sanitize.js";

type MockStreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type MockStreamPart = MockStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 3, reasoning: 1 },
};

function mockModel(text: string, reasoning = ""): MockLanguageModelV4 {
  return mockModelSequence([{ text, reasoning }]);
}

function mockModelSequence(
  responses: Array<{ text: string; reasoning?: string }>,
): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const response = responses[Math.min(index, responses.length - 1)] ?? { text: "" };
      index += 1;
      const chunks: MockStreamPart[] = [
        ...(response.reasoning
          ? [
              { type: "reasoning-start" as const, id: "reasoning-1" },
              { type: "reasoning-delta" as const, id: "reasoning-1", delta: response.reasoning },
              { type: "reasoning-end" as const, id: "reasoning-1" },
            ]
          : []),
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: response.text },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage,
          providerMetadata: { openrouter: { usage: { cost: 0.000_123 } } },
        },
      ];
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
}

function context(deadlineMs = Date.now() + 5_000) {
  return { gameId: "game-1", round: 1 as const, deadlineMs, maxLength: 45 };
}

function quietLogger(): ModelPlayerLogger {
  return { error: vi.fn(), warn: vi.fn() };
}

describe("sanitizeAnswer", () => {
  it("strips quotes, markdown, periods, emoji, and excess whitespace", () => {
    expect(sanitizeAnswer('  **“A   tiny 😀 joke...”**  ')).toBe("A tiny joke");
    expect(sanitizeAnswer("abcdefghijklmnopqrstuvwxyz", { limit: 8 }))
      .toBe("abcdefghijklmnopqrstuvwxyz");
    expect(sanitizeAnswer("!!!")).toBe("no comment");
  });
});

describe("parseFinalAnswers", () => {
  it("prefers a JSON array, sanitizes entries, and pads to three", () => {
    expect(parseFinalAnswers('["**First.**", "Second 😀"]')).toEqual([
      "First",
      "Second",
      "no comment",
    ]);
  });

  it("falls back to newline and comma-separated output", () => {
    expect(parseFinalAnswers("1. Red.\n2. Green.\n3. Blue.")).toEqual(["Red", "Green", "Blue"]);
    expect(parseFinalAnswers("Red, Green, Blue")).toEqual(["Red", "Green", "Blue"]);
  });

  it("parses final answers through the AI SDK mock model", async () => {
    const player = new ModelPlayer({
      model: "test/final",
      displayName: "Final",
      languageModel: mockModel('["One.", "Two", "Three 😀"]'),
      safetyMarginMs: 0,
      logger: quietLogger(),
    });

    await expect(player.answerFinal("Count them", { ...context(), round: 3 })).resolves.toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });
});

describe("parseVote", () => {
  it("accepts letters, one-based numbers, zero, and prefixed choices", () => {
    expect(parseVote("B", 2)).toBe(1);
    expect(parseVote("2", 2)).toBe(1);
    expect(parseVote("0", 2)).toBe(0);
    expect(parseVote("Choice: A", 2)).toBe(0);
    expect(parseVote("The answer is B", 2)).toBe(1);
    expect(parseVote("probably the second one", 2)).toBeUndefined();
  });

  it("parses a model vote and randomly degrades when parsing fails", async () => {
    const parsed = new ModelPlayer({
      model: "test/vote",
      displayName: "Vote",
      languageModel: mockModel("Choice: B"),
      safetyMarginMs: 0,
      logger: quietLogger(),
    });
    await expect(parsed.vote("Pick", ["one", "two"], context())).resolves.toBe(1);

    const logger = quietLogger();
    const fallback = new ModelPlayer({
      model: "test/vote",
      displayName: "Vote",
      languageModel: mockModel("who can say"),
      safetyMarginMs: 0,
      random: () => 0.75,
      logger,
    });
    await expect(fallback.vote("Pick", ["one", "two"], context())).resolves.toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("randomly chose 1"));
  });
});

describe("ModelPlayer streaming", () => {
  it("re-asks an over-length answer in the same conversation and uses the revision", async () => {
    const events: StreamEvent[] = [];
    const model = mockModelSequence([
      { text: "A giant compact disc fortress" },
      { text: "CD fortress" },
    ]);
    const player = new ModelPlayer({
      model: "test/revise",
      displayName: "Revise",
      languageModel: model,
      safetyMarginMs: 0,
      sink: (event) => events.push(event),
      logger: quietLogger(),
    });

    await expect(player.answer("Build something", { ...context(), maxLength: 12 }))
      .resolves.toBe("CD fortress");
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("at most 12 characters");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "That is 29 characters; the limit is 12. Rewrite it so it fits, keep the joke.",
    );
    expect(events.at(-1)).toMatchObject({
      type: "trace.completed",
      answer: "CD fortress",
      attempts: [{
        text: "A giant compact disc fortress",
        reason: "That is 29 characters; the limit is 12. Rewrite it so it fits, keep the joke.",
      }],
      usage: { inputTokens: 14, outputTokens: 8, reasoningTokens: 2, costUsd: 0.000_246 },
    });
  });

  it("truncates only after two corrective attempts also exceed the limit", async () => {
    const model = mockModelSequence([
      { text: "first answer is much too long" },
      { text: "second answer is still too long" },
      { text: "third answer remains too long" },
    ]);
    const events: StreamEvent[] = [];
    const player = new ModelPlayer({
      model: "test/truncate",
      displayName: "Truncate",
      languageModel: model,
      safetyMarginMs: 0,
      sink: (event) => events.push(event),
      logger: quietLogger(),
    });

    await expect(player.answer("Keep trying", { ...context(), maxLength: 10 }))
      .resolves.toBe("third answ");
    expect(model.doStreamCalls).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ attempts: [{}, {}] });
  });

  it("skips a corrective turn when the safety deadline is too close", async () => {
    const model = mockModel("this answer is too long");
    const player = new ModelPlayer({
      model: "test/no-time",
      displayName: "NoTime",
      languageModel: model,
      safetyMarginMs: 1_000,
      logger: quietLogger(),
    });
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(9_500);

    try {
      await expect(player.answer("Hurry", { ...context(10_000), maxLength: 8 }))
        .resolves.toBe("this ans");
      expect(model.doStreamCalls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("prepends harness feedback to the model request", async () => {
    const model = mockModel("Different joke");
    const player = new ModelPlayer({
      model: "test/feedback",
      displayName: "Feedback",
      languageModel: model,
      safetyMarginMs: 0,
      logger: quietLogger(),
    });

    await player.answer("Try again", {
      ...context(),
      feedback: "The game rejected that answer. Give a different one.",
    });
    const request = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(request.indexOf("The game rejected that answer. Give a different one."))
      .toBeLessThan(request.indexOf("Prompt: Try again"));
  });

  it("re-asks only the over-length Thriplash lines", async () => {
    const longLine = "This middle line is much too long";
    const model = mockModelSequence([
      { text: `First\n${longLine}\nThird` },
      { text: "Fixed two" },
    ]);
    const player = new ModelPlayer({
      model: "test/final-revise",
      displayName: "FinalFix",
      languageModel: model,
      safetyMarginMs: 0,
      logger: quietLogger(),
    });

    await expect(player.answerFinal("Three jokes", {
      ...context(),
      round: 3,
      maxLength: 12,
      fieldCount: 3,
    })).resolves.toEqual(["First", "Fixed two", "Third"]);
    expect(model.doStreamCalls).toHaveLength(2);
    const correction = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(correction).toContain("Rewrite only line 2");
    expect(correction).not.toContain("Rewrite only lines 1");
  });

  it("aborts at the safety deadline and returns the partial draft", async () => {
    const model = new MockLanguageModelV4({
      doStream: async (options) => ({
        stream: new ReadableStream<MockStreamPart>({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({ type: "text-delta", id: "text-1", delta: "half a joke" });
            const late = setTimeout(() => {
              controller.enqueue({ type: "text-delta", id: "text-1", delta: " too late" });
              controller.close();
            }, 1_000);
            options.abortSignal?.addEventListener("abort", () => {
              clearTimeout(late);
              controller.error(options.abortSignal?.reason ?? new Error("aborted"));
            }, { once: true });
          },
        }),
      }),
    });
    const drafts: string[] = [];
    const player = new ModelPlayer({
      model: "test/deadline",
      displayName: "Deadline",
      languageModel: model,
      safetyMarginMs: 10,
      logger: quietLogger(),
    });

    const started = Date.now();
    const answer = await player.answer("Finish this", {
      ...context(Date.now() + 40),
      onDraft: (delta) => drafts.push(delta),
    });

    expect(answer).toBe("half a joke");
    expect(drafts).toEqual(["half a joke"]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("returns the blank fallback", async () => {
    const player = new ModelPlayer({
      model: "test/blank",
      displayName: "Blank",
      languageModel: mockModel(" \n "),
      safetyMarginMs: 0,
      logger: quietLogger(),
    });
    await expect(player.answer("Anything", context())).resolves.toBe("no comment");
  });

  it("streams reasoning and draft deltas and emits usage plus OpenRouter cost", async () => {
    const events: StreamEvent[] = [];
    const thinking: string[] = [];
    const drafts: string[] = [];
    const player = new ModelPlayer({
      model: "test/trace",
      displayName: "Trace",
      playerId: "seat-2",
      languageModel: mockModel("A punchline.", "Tiny thought"),
      safetyMarginMs: 0,
      sink: (event) => events.push(event),
      logger: quietLogger(),
    });

    await expect(player.answer("Setup", {
      ...context(),
      onThinking: (delta) => thinking.push(delta),
      onDraft: (delta) => drafts.push(delta),
    })).resolves.toBe("A punchline");

    expect(thinking).toEqual(["Tiny thought"]);
    expect(drafts).toEqual(["A punchline."]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "trace.completed",
      playerId: "seat-2",
      reasoning: "Tiny thought",
      answer: "A punchline",
      usage: { inputTokens: 7, outputTokens: 4, reasoningTokens: 1, costUsd: 0.000_123 },
    });
  });

  it("passes reasoning effort through OpenRouter provider options", async () => {
    const model = mockModel("Done");
    const player = new ModelPlayer({
      model: "test/options",
      displayName: "Options",
      reasoning: { effort: "minimal" },
      temperature: 0.8,
      languageModel: model,
      safetyMarginMs: 0,
      logger: quietLogger(),
    });

    await player.answer("Prompt", context());
    expect(model.doStreamCalls[0]?.providerOptions).toEqual({
      openrouter: { reasoning: { effort: "minimal" } },
    });
    expect(model.doStreamCalls[0]?.temperature).toBe(0.8);
  });

  it("never throws when the provider fails", async () => {
    const logger = quietLogger();
    const player = new ModelPlayer({
      model: "test/error",
      displayName: "Error",
      languageModel: new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("provider down");
        },
      }),
      safetyMarginMs: 0,
      random: () => 0,
      logger,
    });

    await expect(player.answer("Prompt", context())).resolves.toBe("no comment");
    await expect(player.answerFinal("Prompt", { ...context(), round: 3 })).resolves.toEqual([
      "no comment",
      "no comment",
      "no comment",
    ]);
    await expect(player.vote("Prompt", ["A", "B"], context())).resolves.toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });
});
