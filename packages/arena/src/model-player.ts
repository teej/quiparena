import { createOpenRouter, type OpenRouterProviderOptions } from "@openrouter/ai-sdk-provider";
import type { StreamEvent } from "@quiparena/core";
import type { Player, PlayerContext } from "@quiparena/jackbox";
import {
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderMetadata,
} from "ai";

import {
  DEFAULT_ANSWER_LIMIT,
  DEFAULT_FALLBACK,
  parseFinalAnswers,
  parseVote,
  sanitizeAnswer,
} from "./sanitize.js";

export const DEFAULT_REASONING_TOKENS = {
  answer: 400,
  vote: 150,
  thriplash: 600,
} as const;

export const DEFAULT_FAST_RETRY_BUDGET_MS = {
  answer: 5_000,
  vote: 4_000,
} as const;

export const MANDATORY_REASONING_RETRY_TOKENS = 64;

const FAST_OUTPUT_TOKENS = {
  answer: 64,
  vote: 8,
  thriplash: 128,
} as const;

const SYSTEM_PROMPT = [
  "You write Quiplash answers.",
  "Be funny, concise, and specific.",
  "Return only the requested answer in plain text: no explanation, Markdown, surrounding quotes, emoji, or punctuation-only reply.",
  "Obey the character limit and exact output format in the user request.",
].join(" ");

const ANSWER_REASONING_PROMPT = [
  "Before answering, use your reasoning channel to silently brainstorm at least five candidates,",
  "compare them for surprise and specificity, and choose the funniest.",
  "Do not put the brainstorming in the final answer.",
].join(" ");

const VOTE_REASONING_PROMPT = [
  "Before answering, use your reasoning channel to silently compare every choice for humor,",
  "surprise, and specificity, then choose the funniest.",
  "Do not put the comparison in the final answer.",
].join(" ");

export const DEFAULT_SAFETY_MARGIN_MS = 0;

export type ReasoningEffort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
export type ReasoningConfig =
  | { effort: ReasoningEffort }
  | { maxTokens: number; voteMaxTokens?: number | undefined; thriplashMaxTokens?: number | undefined };

export type GenerationPurpose = "answer" | "vote" | "thriplash";
type AttemptKind = "primary" | "fast" | "corrective";

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
  /** Force even fast retries to retain a minimal reasoning budget. */
  reasoningMandatory?: boolean;
  /** Ask adaptive-reasoning models to use their visible reasoning channel. */
  reasoningPrompt?: boolean;
  temperature?: number;
  safetyMarginMs?: number;
  /** Time held back for an answer or Thriplash fast retry. */
  fastRetryBudgetMs?: number;
  /** Time held back for a vote fast retry. */
  voteFastRetryBudgetMs?: number;
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
  kind: AttemptKind;
  ms: number;
  firstTokenMs: number | null;
  startedAfterMs: number;
  aborted: boolean;
  mandatoryReasoningError: boolean;
  correction?: { text: string; reason: string };
}

type TraceEvent = Extract<StreamEvent, { type: "trace.completed" }>;
type TraceAttempt = NonNullable<TraceEvent["attempts"]>[number];

const DEFAULT_LOGGER: ModelPlayerLogger = {
  error: (message, error) => console.error(message, error),
  warn: (message) => console.warn(message),
};

const mandatoryReasoningModels = new Set<string>();
const loggedMandatoryReasoningModels = new Set<string>();

function providerReasoning(reasoning: ReasoningConfig): OpenRouterProviderOptions["reasoning"] {
  return "maxTokens" in reasoning
    ? { max_tokens: reasoning.maxTokens }
    : { effort: reasoning.effort };
}

// `exclude` only controls returned reasoning. `enabled: false` and effort none
// tell OpenRouter/providers not to spend tokens on it in retry/corrective calls.
const DISABLED_PROVIDER_REASONING: OpenRouterProviderOptions["reasoning"] = {
  enabled: false,
  exclude: true,
  effort: "none",
};

const MINIMAL_PROVIDER_REASONING: OpenRouterProviderOptions["reasoning"] = {
  max_tokens: MANDATORY_REASONING_RETRY_TOKENS,
};

type RetryReasoningMode = "configured" | "disabled" | "minimal";

export function splitAttemptDeadlines(
  deadlineMs: number,
  purpose: GenerationPurpose,
  options: {
    answerRetryBudgetMs?: number;
    voteRetryBudgetMs?: number;
    safetyMarginMs?: number;
  } = {},
): { primaryDeadlineMs: number; retryDeadlineMs: number } {
  const retryBudgetMs = purpose === "vote"
    ? options.voteRetryBudgetMs ?? DEFAULT_FAST_RETRY_BUDGET_MS.vote
    : options.answerRetryBudgetMs ?? DEFAULT_FAST_RETRY_BUDGET_MS.answer;
  const retryDeadlineMs = deadlineMs - (options.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS);
  return {
    primaryDeadlineMs: retryDeadlineMs - retryBudgetMs,
    retryDeadlineMs,
  };
}

function errorText(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || seen.has(value)) return String(value ?? "");
  seen.add(value);
  const record = value as Record<string, unknown>;
  return [record["name"], record["message"], record["cause"], record["data"], record["responseBody"]]
    .map((item) => errorText(item, seen))
    .join(" ");
}

export function isMandatoryReasoningError(error: unknown): boolean {
  const message = errorText(error);
  return /reasoning is mandatory|reasoning.{0,40}(?:must|required).{0,20}(?:enabled|true)|reasoning.{0,40}cannot be disabled/iu.test(message);
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
): Omit<NonNullable<TraceEvent["usage"]>, "totalMs" | "firstTokenMs"> | undefined {
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

function combinedTraceUsage(
  generations: readonly GenerationResult[],
  totalMs: number,
): NonNullable<TraceEvent["usage"]> {
  const usages = generations
    .map((generated) => traceUsage(generated.usage, generated.providerMetadata))
    .filter((usage) => usage !== undefined);
  const reasoningTokens = usages.some((usage) => usage.reasoningTokens !== undefined)
    ? usages.reduce((sum, usage) => sum + (usage.reasoningTokens ?? 0), 0)
    : undefined;
  const costUsd = usages.some((usage) => usage.costUsd !== undefined)
    ? usages.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0)
    : undefined;
  const firstTokenMs = generations.reduce<number | null>((first, generated) => {
    if (generated.firstTokenMs === null) return first;
    const observed = generated.startedAfterMs + generated.firstTokenMs;
    return first === null ? observed : Math.min(first, observed);
  }, null);
  return {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    totalMs,
    firstTokenMs,
  };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function hasUsableText(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function hasUsableFinalText(value: string, fieldCount: number): boolean {
  const missing = "quiparena missing answer marker";
  return parseFinalAnswers(value, { fallback: missing })
    .slice(0, fieldCount)
    .every((answer) => answer !== missing);
}

function characters(value: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(value)].map((part) => part.segment);
}

function characterLength(value: string): number {
  return characters(value).length;
}

function truncateToLimit(value: string, limit: number): string {
  return characters(value).slice(0, limit).join("").trim().replace(/\.+$/u, "").trim();
}

export class ModelPlayer implements Player {
  readonly name: string;
  readonly modelId: string;

  private readonly playerId: string;
  private readonly reasoning: ReasoningConfig | null;
  private readonly reasoningPrompt: boolean;
  private readonly temperature: number | undefined;
  private readonly safetyMarginMs: number;
  private readonly fastRetryBudgetMs: number;
  private readonly voteFastRetryBudgetMs: number;
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
    if (config.reasoning && "maxTokens" in config.reasoning) {
      const budgets = [
        config.reasoning.maxTokens,
        config.reasoning.voteMaxTokens,
        config.reasoning.thriplashMaxTokens,
      ].filter((budget) => budget !== undefined);
      if (budgets.some((budget) => !Number.isInteger(budget) || budget < 1)) {
        throw new RangeError("Reasoning token budgets must be positive integers");
      }
    }
    for (const budget of [config.fastRetryBudgetMs, config.voteFastRetryBudgetMs]) {
      if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) {
        throw new RangeError("Fast retry budgets must be non-negative numbers");
      }
    }
    if (config.answerLimit !== undefined
      && (!Number.isInteger(config.answerLimit) || config.answerLimit < 1)) {
      throw new RangeError("Answer limit must be a positive integer");
    }

    this.name = config.displayName;
    this.modelId = config.model;
    this.playerId = config.playerId ?? config.model;
    this.reasoning = config.reasoning ?? null;
    this.reasoningPrompt = config.reasoningPrompt ?? false;
    this.temperature = config.temperature;
    this.safetyMarginMs = config.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
    this.fastRetryBudgetMs = config.fastRetryBudgetMs ?? DEFAULT_FAST_RETRY_BUDGET_MS.answer;
    this.voteFastRetryBudgetMs = config.voteFastRetryBudgetMs ?? DEFAULT_FAST_RETRY_BUDGET_MS.vote;
    this.answerLimit = config.answerLimit ?? DEFAULT_ANSWER_LIMIT;
    this.fallback = sanitizeAnswer(config.fallback ?? DEFAULT_FALLBACK);
    this.sink = config.sink;
    this.logger = config.logger ?? DEFAULT_LOGGER;
    this.onFailure = config.onFailure;
    this.random = config.random ?? Math.random;
    if (config.reasoningMandatory) mandatoryReasoningModels.add(this.modelId);

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
    const startedAt = performance.now();
    const maxLength = this.contextMaxLength(ctx);
    const request = [
      `Prompt: ${prompt}`,
      `Write one funny answer of at most ${maxLength} characters.`,
      "Return the answer only.",
    ].join("\n");
    const messages: ModelMessage[] = [{ role: "user", content: this.withFeedback(request, ctx) }];
    const generations: GenerationResult[] = [];

    let generated = await this.generateInitial(
      messages,
      ctx,
      "answer",
      128,
      generations,
      startedAt,
      hasUsableText,
    );
    const budgetMiss = !hasUsableText(generated.text) && this.exhaustedBothAttempts(generations);
    let answer = sanitizeAnswer(generated.text, { fallback: this.fallback });
    for (let reasks = 0; reasks < 2 && characterLength(answer) > maxLength; reasks += 1) {
      if (!this.canReask(ctx)) break;
      const reason = `That is ${characterLength(answer)} characters; the limit is ${maxLength}. Rewrite it so it fits, keep the joke.`;
      messages.push(
        { role: "assistant", content: generated.text },
        { role: "user", content: reason },
      );
      generated = await this.generate(messages, ctx, {
        answerTokens: FAST_OUTPUT_TOKENS.answer,
        abortAtMs: ctx.deadlineMs - this.safetyMarginMs,
        kind: "corrective",
        purpose: "answer",
        reasoningMode: this.retryReasoningMode(),
        traceStartedAt: startedAt,
        correction: { text: answer, reason },
      });
      generations.push(generated);
      if (!hasUsableText(generated.text)) break;
      answer = sanitizeAnswer(generated.text, { fallback: this.fallback });
    }

    if (characterLength(answer) > maxLength) answer = truncateToLimit(answer, maxLength);
    this.emitTrace(prompt, answer, generations, ctx, startedAt, "answer", budgetMiss);
    return answer;
  }

  async answerFinal(prompt: string, ctx: PlayerContext): Promise<[string, string, string]> {
    const startedAt = performance.now();
    const maxLength = this.contextMaxLength(ctx);
    const fieldCount = Number.isInteger(ctx.fieldCount) && (ctx.fieldCount ?? 0) > 0
      ? Math.min(3, ctx.fieldCount ?? 3)
      : 3;
    const request = [
      `Thriplash prompt: ${prompt}`,
      `Write exactly ${fieldCount} funny answers, each at most ${maxLength} characters.`,
      `Return exactly ${fieldCount} lines, one answer per line, with no numbering or other text.`,
    ].join("\n");
    const messages: ModelMessage[] = [{ role: "user", content: this.withFeedback(request, ctx) }];
    const generations: GenerationResult[] = [];

    let generated = await this.generateInitial(
      messages,
      ctx,
      "thriplash",
      256,
      generations,
      startedAt,
      (text) => hasUsableFinalText(text, fieldCount),
    );
    const budgetMiss = !hasUsableFinalText(generated.text, fieldCount)
      && this.exhaustedBothAttempts(generations);
    const answers = parseFinalAnswers(generated.text, { fallback: this.fallback });
    for (let reasks = 0; reasks < 2; reasks += 1) {
      const overLimit = answers
        .slice(0, fieldCount)
        .map((answer, index) => ({ answer, index, length: characterLength(answer) }))
        .filter((line) => line.length > maxLength);
      if (overLimit.length === 0 || !this.canReask(ctx)) break;

      const labels = overLimit.map((line) => `line ${line.index + 1} is ${line.length}`).join("; ");
      const indices = overLimit.map((line) => line.index + 1).join(", ");
      const reason = [
        `${labels}; the limit is ${maxLength} characters per line.`,
        `Rewrite only ${overLimit.length === 1 ? `line ${indices}` : `lines ${indices}`} so ${overLimit.length === 1 ? "it fits" : "they fit"}, keeping the jokes.`,
        `Return only ${overLimit.length === 1 ? "the replacement line" : `${overLimit.length} replacement lines in that order`} with no numbering or other text.`,
      ].join(" ");
      messages.push(
        { role: "assistant", content: generated.text },
        { role: "user", content: reason },
      );
      generated = await this.generate(messages, ctx, {
        answerTokens: FAST_OUTPUT_TOKENS.thriplash,
        abortAtMs: ctx.deadlineMs - this.safetyMarginMs,
        kind: "corrective",
        purpose: "thriplash",
        reasoningMode: this.retryReasoningMode(),
        traceStartedAt: startedAt,
        correction: { text: overLimit.map((line) => line.answer).join("\n"), reason },
      });
      generations.push(generated);
      if (!hasUsableFinalText(generated.text, overLimit.length)) break;
      const replacements = this.parseFinalReplacements(generated.text, overLimit.length);
      overLimit.forEach((line, index) => {
        answers[line.index] = replacements[index] ?? this.fallback;
      });
    }

    answers.forEach((answer, index) => {
      if (characterLength(answer) > maxLength) answers[index] = truncateToLimit(answer, maxLength);
    });
    this.emitTrace(
      prompt,
      answers.join("\n"),
      generations,
      ctx,
      startedAt,
      "thriplash",
      budgetMiss,
    );
    return answers;
  }

  async vote(prompt: string, options: string[], ctx: PlayerContext): Promise<number> {
    const startedAt = performance.now();
    if (options.length === 0) {
      this.logWarn(`[${this.modelId}] vote requested without options; choosing index 0`);
      this.emitTrace(prompt, "0", [], ctx, startedAt, "vote", false);
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
    const generations: GenerationResult[] = [];
    const generated = await this.generateInitial(
      [{ role: "user", content: this.withFeedback(request, ctx) }],
      ctx,
      "vote",
      16,
      generations,
      startedAt,
      (text) => parseVote(text, options.length) !== undefined,
    );
    const budgetMiss = parseVote(generated.text, options.length) === undefined
      && this.exhaustedBothAttempts(generations);
    let choice = parseVote(generated.text, options.length);
    if (choice === undefined) {
      choice = this.randomChoice(options.length);
      this.logWarn(
        `[${this.modelId}] could not parse vote ${JSON.stringify(generated.text)}; randomly chose ${choice}`,
      );
    }
    this.emitTrace(prompt, String(choice), generations, ctx, startedAt, "vote", budgetMiss);
    return choice;
  }

  private async generateInitial(
    messages: ModelMessage[],
    ctx: PlayerContext,
    purpose: GenerationPurpose,
    answerTokens: number,
    generations: GenerationResult[],
    traceStartedAt: number,
    isUsable: (text: string) => boolean,
  ): Promise<GenerationResult> {
    const deadlines = splitAttemptDeadlines(ctx.deadlineMs, purpose, {
      answerRetryBudgetMs: this.fastRetryBudgetMs,
      voteRetryBudgetMs: this.voteFastRetryBudgetMs,
      safetyMarginMs: this.safetyMarginMs,
    });
    const primary = await this.generate(messages, ctx, {
      answerTokens,
      abortAtMs: deadlines.primaryDeadlineMs,
      kind: "primary",
      purpose,
      reasoningMode: "configured",
      traceStartedAt,
    });
    generations.push(primary);
    if (isUsable(primary.text)) return primary;

    let fast = await this.generate(messages, ctx, {
      answerTokens: FAST_OUTPUT_TOKENS[purpose],
      abortAtMs: deadlines.retryDeadlineMs,
      kind: "fast",
      purpose,
      reasoningMode: this.retryReasoningMode(),
      traceStartedAt,
    });
    generations.push(fast);
    if (fast.mandatoryReasoningError && !isUsable(fast.text) && Date.now() < deadlines.retryDeadlineMs) {
      fast = await this.generate(messages, ctx, {
        answerTokens: FAST_OUTPUT_TOKENS[purpose],
        abortAtMs: deadlines.retryDeadlineMs,
        kind: "fast",
        purpose,
        reasoningMode: "minimal",
        traceStartedAt,
      });
      generations.push(fast);
    }
    return fast;
  }

  private async generate(
    messages: ModelMessage[],
    ctx: PlayerContext,
    options: {
      answerTokens: number;
      abortAtMs: number;
      kind: AttemptKind;
      purpose: GenerationPurpose;
      reasoningMode: RetryReasoningMode;
      traceStartedAt: number;
      correction?: { text: string; reason: string };
    },
  ): Promise<GenerationResult> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const abortAfterMs = options.abortAtMs - Date.now();
    const abort = () => controller.abort(new Error(`QuipArena ${options.kind} attempt budget reached`));
    const timer = abortAfterMs <= 0 ? undefined : setTimeout(abort, abortAfterMs);
    if (abortAfterMs <= 0) abort();

    let text = "";
    let reasoningText = "";
    let usage: LanguageModelUsage | undefined;
    let providerMetadata: ProviderMetadata | undefined;
    let firstTokenMs: number | null = null;
    let aborted = controller.signal.aborted;
    let mandatoryReasoningError = false;
    const configuredReasoning = options.reasoningMode === "configured"
      ? this.reasoningFor(options.purpose)
      : options.reasoningMode === "minimal"
        ? { maxTokens: MANDATORY_REASONING_RETRY_TOKENS } satisfies ReasoningConfig
        : null;
    const reasoningTokens = configuredReasoning === null
      ? 0
      : "maxTokens" in configuredReasoning
        ? configuredReasoning.maxTokens
        : this.reasoningBudget(options.purpose);
    const maxOutputTokens = options.answerTokens + reasoningTokens;

    try {
      const result = streamText({
        model: this.languageModel,
        system: this.systemPrompt(options.purpose, options.reasoningMode, configuredReasoning),
        messages,
        maxOutputTokens,
        maxRetries: 0,
        abortSignal: controller.signal,
        onError: () => undefined,
        ...(this.temperature === undefined ? {} : { temperature: this.temperature }),
        ...(options.reasoningMode === "disabled"
          ? this.reasoning === null
            ? {}
            : { providerOptions: { openrouter: { reasoning: DISABLED_PROVIDER_REASONING } } }
          : options.reasoningMode === "minimal"
            ? { providerOptions: { openrouter: { reasoning: MINIMAL_PROVIDER_REASONING } } }
          : configuredReasoning === null
            ? {}
            : {
                providerOptions: {
                  openrouter: { reasoning: providerReasoning(configuredReasoning) },
                },
              }),
      });

      for await (const part of result.stream) {
        switch (part.type) {
          case "reasoning-delta":
            if (firstTokenMs === null && part.text) firstTokenMs = elapsedMs(startedAt);
            reasoningText += part.text;
            this.callHook(ctx.onThinking, part.text, "thinking");
            break;
          case "text-delta":
            if (firstTokenMs === null && part.text) firstTokenMs = elapsedMs(startedAt);
            text += part.text;
            this.callHook(ctx.onDraft, part.text, "draft");
            break;
          case "finish-step":
            usage = part.usage;
            providerMetadata = part.providerMetadata;
            break;
          case "error":
            if (options.reasoningMode === "disabled" && isMandatoryReasoningError(part.error)) {
              mandatoryReasoningError = true;
              this.rememberMandatoryReasoning();
            } else {
              this.logError(`[${this.modelId}] model stream error`, part.error);
              this.reportFailure(part.error, ctx);
            }
            break;
          case "abort":
            aborted = true;
            break;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        aborted = true;
        this.logWarn(`[${this.modelId}] ${options.kind} generation stopped at its time budget`);
        this.reportFailure(new Error("Model generation timed out"), ctx);
      } else if (options.reasoningMode === "disabled" && isMandatoryReasoningError(error)) {
        mandatoryReasoningError = true;
        this.rememberMandatoryReasoning();
      } else {
        this.logError(`[${this.modelId}] generation failed`, error);
        this.reportFailure(error, ctx);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    return {
      text,
      reasoning: reasoningText,
      kind: options.kind,
      ms: elapsedMs(startedAt),
      firstTokenMs,
      startedAfterMs: Math.max(0, Math.round(startedAt - options.traceStartedAt)),
      aborted,
      mandatoryReasoningError,
      ...(options.correction === undefined ? {} : { correction: options.correction }),
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

  private systemPrompt(
    purpose: GenerationPurpose,
    reasoningMode: RetryReasoningMode,
    configuredReasoning: ReasoningConfig | null,
  ): string {
    const reasoningDisabled = configuredReasoning === null
      || ("effort" in configuredReasoning && configuredReasoning.effort === "none");
    if (!this.reasoningPrompt || reasoningMode !== "configured" || reasoningDisabled) {
      return SYSTEM_PROMPT;
    }
    return `${SYSTEM_PROMPT} ${purpose === "vote" ? VOTE_REASONING_PROMPT : ANSWER_REASONING_PROMPT}`;
  }

  private emitTrace(
    prompt: string,
    answer: string,
    generations: readonly GenerationResult[],
    ctx: PlayerContext,
    startedAt: number,
    purpose: GenerationPurpose,
    budgetMiss: boolean,
  ): void {
    if (!this.sink) return;
    const attempts: TraceAttempt[] = generations.map((generated) => ({
      kind: generated.kind,
      ms: generated.ms,
      firstTokenMs: generated.firstTokenMs,
      reasoningTokens: generated.usage?.outputTokenDetails.reasoningTokens ?? 0,
      aborted: generated.aborted,
      ...(generated.correction ?? {}),
    }));
    const event: StreamEvent = {
      type: "trace.completed",
      gameId: ctx.gameId,
      playerId: this.playerId,
      purpose,
      prompt,
      reasoning: generations.map((generated) => generated.reasoning).filter(Boolean).join("\n\n"),
      answer,
      ...(budgetMiss ? { budgetMiss: true } : {}),
      attempts,
      usage: combinedTraceUsage(generations, elapsedMs(startedAt)),
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

  private contextMaxLength(ctx: PlayerContext): number {
    if (Number.isInteger(ctx.maxLength) && ctx.maxLength > 0) return ctx.maxLength;
    this.logWarn(`[${this.modelId}] invalid context maxLength; using ${this.answerLimit}`);
    return this.answerLimit;
  }

  private withFeedback(request: string, ctx: PlayerContext): string {
    return ctx.feedback ? `${ctx.feedback}\n\n${request}` : request;
  }

  private canReask(ctx: PlayerContext): boolean {
    return Date.now() < ctx.deadlineMs - this.safetyMarginMs;
  }

  private retryReasoningMode(): RetryReasoningMode {
    if (!mandatoryReasoningModels.has(this.modelId)) return "disabled";
    this.logMandatoryReasoningOnce();
    return "minimal";
  }

  private rememberMandatoryReasoning(): void {
    mandatoryReasoningModels.add(this.modelId);
    this.logMandatoryReasoningOnce();
  }

  private logMandatoryReasoningOnce(): void {
    if (loggedMandatoryReasoningModels.has(this.modelId)) return;
    loggedMandatoryReasoningModels.add(this.modelId);
    this.logWarn(
      `[${this.modelId}] reasoning is mandatory; retries use a minimal ${MANDATORY_REASONING_RETRY_TOKENS}-token reasoning budget`,
    );
  }

  private exhaustedBothAttempts(generations: readonly GenerationResult[]): boolean {
    return generations.some((generation) => generation.kind === "primary" && generation.aborted)
      && generations.some((generation) => generation.kind === "fast" && generation.aborted);
  }

  private reasoningFor(purpose: GenerationPurpose): ReasoningConfig | null {
    if (this.reasoning === null || "effort" in this.reasoning) return this.reasoning;
    switch (purpose) {
      case "answer":
        return { maxTokens: this.reasoning.maxTokens };
      case "vote":
        return { maxTokens: this.reasoning.voteMaxTokens ?? DEFAULT_REASONING_TOKENS.vote };
      case "thriplash":
        return {
          maxTokens: this.reasoning.thriplashMaxTokens ?? DEFAULT_REASONING_TOKENS.thriplash,
        };
    }
  }

  private reasoningBudget(purpose: GenerationPurpose): number {
    const reasoning = this.reasoningFor(purpose);
    if (reasoning !== null && "maxTokens" in reasoning) return reasoning.maxTokens;
    return DEFAULT_REASONING_TOKENS[purpose];
  }

  private parseFinalReplacements(value: string, count: number): string[] {
    if (count === 1) return [sanitizeAnswer(value, { fallback: this.fallback })];
    return parseFinalAnswers(value, { fallback: this.fallback }).slice(0, count);
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
