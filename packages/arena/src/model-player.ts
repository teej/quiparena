import { createOpenRouter, type OpenRouterProviderOptions } from "@openrouter/ai-sdk-provider";
import type { StreamEvent } from "@quiparena/core";
import type { Player, PlayerContext } from "@quiparena/jackbox";
import {
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ProviderMetadata,
} from "ai";

import {
  DEFAULT_ANSWER_LIMIT,
  DEFAULT_FALLBACK,
  parseFinalAnswers,
  parseVote,
  sanitizeAnswer,
} from "./sanitize.js";

export /** Output-token headroom for effort-based reasoning; the deadline bounds time. */
const REASONING_HEADROOM_TOKENS = 16_000;

const SYSTEM_PROMPT = [
  "You write Quiplash answers.",
  "Be funny, concise, and specific.",
  "Return only the requested answer in plain text: no explanation, Markdown, surrounding quotes, emoji, or punctuation-only reply.",
  "Obey the character limit and exact output format in the user request.",
].join(" ");

export const DEFAULT_SAFETY_MARGIN_MS = 4_000;

export type ReasoningEffort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
export type ReasoningConfig =
  | { effort: ReasoningEffort }
  | { maxTokens: number };

/** A deliberately tiny interface so traces can go to a websocket, recorder, or console. */
export interface EventSink {
  (event: StreamEvent): void | Promise<void>;
}

export const ConsoleSink: EventSink = (event) => {
  console.log(JSON.stringify(event));
};

export interface ModelPlayerLogger {
  error(message: string, error?: unknown): void;
  warn(message: string): void;
}

export interface ModelPlayerConfig {
  model: string;
  displayName: string;
  reasoning?: ReasoningConfig | null;
  temperature?: number;
  safetyMarginMs?: number;
  answerLimit?: number;
  fallback?: string;
  playerId?: string;
  apiKey?: string;
  sink?: EventSink;
  logger?: ModelPlayerLogger;
  /** Called when generation throws or reaches its deadline, for worker bench accounting. */
  onFailure?: (error: Error, ctx: PlayerContext) => void;
  random?: () => number;
  /** Dependency-injection seam for AI SDK mock models. */
  languageModel?: LanguageModel;
}

interface GenerationResult {
  text: string;
  reasoning: string;
  usage?: LanguageModelUsage;
  providerMetadata?: ProviderMetadata;
}

const DEFAULT_LOGGER: ModelPlayerLogger = {
  error: (message, error) => console.error(message, error),
  warn: (message) => console.warn(message),
};

function providerReasoning(reasoning: ReasoningConfig): OpenRouterProviderOptions["reasoning"] {
  return "maxTokens" in reasoning
    ? { max_tokens: reasoning.maxTokens }
    : { effort: reasoning.effort };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function costFrom(metadata: ProviderMetadata | undefined): number | undefined {
  const openrouter = metadata?.["openrouter"];
  if (!isRecord(openrouter)) return undefined;
  const usage = openrouter["usage"];
  if (!isRecord(usage)) return undefined;
  const cost = usage["cost"];
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

function traceUsage(
  usage: LanguageModelUsage | undefined,
  providerMetadata: ProviderMetadata | undefined,
): Extract<StreamEvent, { type: "trace.completed" }>["usage"] | undefined {
  if (!usage) return undefined;
  const costUsd = costFrom(providerMetadata);
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.outputTokenDetails.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

export class ModelPlayer implements Player {
  readonly name: string;
  readonly modelId: string;

  private readonly playerId: string;
  private readonly reasoning: ReasoningConfig | null;
  private readonly temperature: number | undefined;
  private readonly safetyMarginMs: number;
  private readonly answerLimit: number;
  private readonly fallback: string;
  private readonly sink: EventSink | undefined;
  private readonly logger: ModelPlayerLogger;
  private readonly onFailure: ((error: Error, ctx: PlayerContext) => void) | undefined;
  private readonly random: () => number;
  private readonly languageModel: LanguageModel;

  constructor(config: ModelPlayerConfig) {
    if (!config.model.trim()) throw new Error("Model slug is required");
    if (!config.displayName.trim() || config.displayName.length > 12) {
      throw new Error("Display name must contain 1-12 characters");
    }
    if (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) {
      throw new RangeError("Temperature must be between 0 and 2");
    }
    if (config.safetyMarginMs !== undefined && (!Number.isFinite(config.safetyMarginMs) || config.safetyMarginMs < 0)) {
      throw new RangeError("Safety margin must be a non-negative number");
    }
    if (config.reasoning && "maxTokens" in config.reasoning
      && (!Number.isInteger(config.reasoning.maxTokens) || config.reasoning.maxTokens < 1)) {
      throw new RangeError("Reasoning token budget must be a positive integer");
    }

    this.name = config.displayName;
    this.modelId = config.model;
    this.playerId = config.playerId ?? config.model;
    this.reasoning = config.reasoning ?? null;
    this.temperature = config.temperature;
    this.safetyMarginMs = config.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
    this.answerLimit = config.answerLimit ?? DEFAULT_ANSWER_LIMIT;
    this.fallback = sanitizeAnswer(config.fallback ?? DEFAULT_FALLBACK, { limit: this.answerLimit });
    this.sink = config.sink;
    this.logger = config.logger ?? DEFAULT_LOGGER;
    this.onFailure = config.onFailure;
    this.random = config.random ?? Math.random;

    if (config.languageModel) {
      this.languageModel = config.languageModel;
    } else {
      const provider = createOpenRouter({
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        appName: "QuipArena",
        compatibility: "strict",
      });
      this.languageModel = provider.chat(config.model, { usage: { include: true } });
    }
  }

  async answer(prompt: string, ctx: PlayerContext): Promise<string> {
    const request = [
      `Prompt: ${prompt}`,
      `Write one funny answer of at most ${this.answerLimit} characters.`,
      "Return the answer only.",
    ].join("\n");
    const generated = await this.generate(request, ctx, 128);
    const answer = sanitizeAnswer(generated.text, {
      limit: this.answerLimit,
      fallback: this.fallback,
    });
    this.emitTrace(prompt, answer, generated, ctx);
    return answer;
  }

  async answerFinal(prompt: string, ctx: PlayerContext): Promise<[string, string, string]> {
    const request = [
      `Thriplash prompt: ${prompt}`,
      `Write exactly three funny answers, each at most ${this.answerLimit} characters.`,
      "Return exactly three lines, one answer per line, with no numbering or other text.",
    ].join("\n");
    const generated = await this.generate(request, ctx, 256);
    const answers = parseFinalAnswers(generated.text, {
      limit: this.answerLimit,
      fallback: this.fallback,
    });
    this.emitTrace(prompt, answers.join("\n"), generated, ctx);
    return answers;
  }

  async vote(prompt: string, options: string[], ctx: PlayerContext): Promise<number> {
    if (options.length === 0) {
      this.logWarn(`[${this.modelId}] vote requested without options; choosing index 0`);
      const generated: GenerationResult = { text: "", reasoning: "" };
      this.emitTrace(prompt, "0", generated, ctx);
      return 0;
    }

    const listed = options
      .map((option, index) => `${String.fromCharCode(65 + index)} (${index + 1}): ${option}`)
      .join("\n");
    const request = [
      `Prompt: ${prompt}`,
      "Pick the funniest answer:",
      listed,
      "Return one letter or number only.",
    ].join("\n");
    const generated = await this.generate(request, ctx, 16);
    let choice = parseVote(generated.text, options.length);
    if (choice === undefined) {
      choice = this.randomChoice(options.length);
      this.logWarn(
        `[${this.modelId}] could not parse vote ${JSON.stringify(generated.text)}; randomly chose ${choice}`,
      );
    }
    this.emitTrace(prompt, String(choice), generated, ctx);
    return choice;
  }

  private async generate(
    prompt: string,
    ctx: PlayerContext,
    answerTokens: number,
  ): Promise<GenerationResult> {
    const controller = new AbortController();
    const abortAfterMs = Math.max(0, ctx.deadlineMs - Date.now() - this.safetyMarginMs);
    const timer = setTimeout(() => {
      controller.abort(new Error("QuipArena player deadline reached"));
    }, abortAfterMs);

    let text = "";
    let reasoning = "";
    let usage: LanguageModelUsage | undefined;
    let providerMetadata: ProviderMetadata | undefined;
    // Reasoning tokens count against the output cap on most providers, so a
    // reasoning-enabled player needs headroom. The deadline is the real budget.
    const maxOutputTokens = this.reasoning === null
      ? answerTokens
      : "maxTokens" in this.reasoning
        ? this.reasoning.maxTokens + answerTokens
        : REASONING_HEADROOM_TOKENS + answerTokens;

    try {
      const result = streamText({
        model: this.languageModel,
        system: SYSTEM_PROMPT,
        prompt,
        maxOutputTokens,
        maxRetries: 0,
        abortSignal: controller.signal,
        ...(this.temperature === undefined ? {} : { temperature: this.temperature }),
        ...(this.reasoning === null
          ? {}
          : {
              providerOptions: {
                openrouter: { reasoning: providerReasoning(this.reasoning) },
              },
            }),
      });

      for await (const part of result.stream) {
        switch (part.type) {
          case "reasoning-delta":
            reasoning += part.text;
            this.callHook(ctx.onThinking, part.text, "thinking");
            break;
          case "text-delta":
            text += part.text;
            this.callHook(ctx.onDraft, part.text, "draft");
            break;
          case "finish-step":
            usage = part.usage;
            providerMetadata = part.providerMetadata;
            break;
          case "error":
            this.logError(`[${this.modelId}] model stream error`, part.error);
            this.reportFailure(part.error, ctx);
            break;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.logWarn(`[${this.modelId}] generation stopped at the deadline`);
        this.reportFailure(new Error("Model generation timed out"), ctx);
      } else {
        this.logError(`[${this.modelId}] generation failed`, error);
        this.reportFailure(error, ctx);
      }
    } finally {
      clearTimeout(timer);
    }

    return {
      text: text || this.fallback,
      reasoning,
      ...(usage === undefined ? {} : { usage }),
      ...(providerMetadata === undefined ? {} : { providerMetadata }),
    };
  }

  private callHook(hook: ((text: string) => void) | undefined, text: string, label: string): void {
    if (!hook) return;
    try {
      hook(text);
    } catch (error) {
      this.logError(`[${this.modelId}] ${label} hook failed`, error);
    }
  }

  private emitTrace(
    prompt: string,
    answer: string,
    generated: GenerationResult,
    ctx: PlayerContext,
  ): void {
    if (!this.sink) return;
    const usage = traceUsage(generated.usage, generated.providerMetadata);
    const event: StreamEvent = {
      type: "trace.completed",
      gameId: ctx.gameId,
      playerId: this.playerId,
      prompt,
      reasoning: generated.reasoning,
      answer,
      ...(usage === undefined ? {} : { usage }),
      at: new Date().toISOString(),
    };

    try {
      void Promise.resolve(this.sink(event)).catch((error: unknown) => {
        this.logError(`[${this.modelId}] trace sink failed`, error);
      });
    } catch (error) {
      this.logError(`[${this.modelId}] trace sink failed`, error);
    }
  }

  private randomChoice(optionCount: number): number {
    try {
      const sample = this.random();
      if (Number.isFinite(sample)) {
        return Math.min(optionCount - 1, Math.max(0, Math.floor(sample * optionCount)));
      }
      this.logWarn(`[${this.modelId}] random source returned a non-finite value; choosing index 0`);
    } catch (error) {
      this.logError(`[${this.modelId}] random source failed; choosing index 0`, error);
    }
    return 0;
  }

  private logError(message: string, error?: unknown): void {
    try {
      this.logger.error(message, error);
    } catch {
      // Logging must never prevent the harness from receiving a response.
    }
  }

  private reportFailure(error: unknown, ctx: PlayerContext): void {
    if (!this.onFailure) return;
    try {
      this.onFailure(error instanceof Error ? error : new Error(String(error)), ctx);
    } catch (reportError) {
      this.logError(`[${this.modelId}] failure hook failed`, reportError);
    }
  }

  private logWarn(message: string): void {
    try {
      this.logger.warn(message);
    } catch {
      // Logging must never prevent the harness from receiving a response.
    }
  }
}
