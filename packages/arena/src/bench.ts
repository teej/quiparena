import type { StreamEvent } from "@quiparena/core";

import { ModelPlayer, type ModelPlayerLogger } from "./model-player.js";
import { loadRoster, type RosterModel } from "./registry.js";
import { DEFAULT_FALLBACK } from "./sanitize.js";

const CONCURRENCY = 8;
const SPEND_CAP_USD = 3;
const PROMPTS = [
  {
    prompt: "The worst thing to hear from your dentist",
    voteOptions: ["This drill is mostly decorative", "Your teeth have unionized"],
  },
  {
    prompt: "A rejected slogan for the moon",
    voteOptions: ["Come for the craters, stay because gravity", "Earth's night-light with parking"],
  },
  {
    prompt: "The real reason pigeons bob their heads",
    voteOptions: ["Buffering street directions", "Tiny invisible podcast beats"],
  },
] as const;

type TraceEvent = Extract<StreamEvent, { type: "trace.completed" }>;

interface BenchOptions {
  modelSlugs?: Set<string>;
  budgetMs: number;
}

interface OperationResult {
  kind: "answer" | "vote";
  totalMs: number;
  firstTokenMs: number | null;
  reasoningTokens: number;
  costUsd: number;
  fallbackUsed: boolean;
  budgetMiss: boolean;
}

interface ModelResult {
  entry: RosterModel;
  operations: OperationResult[];
  skippedReason?: string;
}

function parsePositiveSeconds(value: string | undefined): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--budget-s must be a positive number, received ${JSON.stringify(value)}`);
  }
  return Math.round(seconds * 1_000);
}

function parseOptions(args: string[]): BenchOptions {
  let budgetMs = 15_000;
  let modelSlugs: Set<string> | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--models" || argument?.startsWith("--models=")) {
      const value = argument === "--models" ? args[index += 1] : argument.slice("--models=".length);
      const slugs = value?.split(",").map((slug) => slug.trim()).filter(Boolean) ?? [];
      if (slugs.length === 0) throw new Error("--models requires a comma-separated model list");
      modelSlugs = new Set(slugs);
      continue;
    }
    if (argument === "--budget-s" || argument?.startsWith("--budget-s=")
      || argument === "--deadline-s" || argument?.startsWith("--deadline-s=")) {
      const value = argument === "--budget-s" || argument === "--deadline-s"
        ? args[index += 1]
        : argument.slice(argument.indexOf("=") + 1);
      budgetMs = parsePositiveSeconds(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { budgetMs, ...(modelSlugs === undefined ? {} : { modelSlugs }) };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function operationFromTrace(
  kind: OperationResult["kind"],
  trace: TraceEvent,
  fallbackUsed: boolean,
): OperationResult {
  const attempts = trace.attempts ?? [];
  return {
    kind,
    totalMs: trace.usage?.totalMs ?? attempts.reduce((sum, attempt) => sum + attempt.ms, 0),
    firstTokenMs: trace.usage?.firstTokenMs
      ?? attempts.find((attempt) => attempt.firstTokenMs !== null)?.firstTokenMs
      ?? null,
    reasoningTokens: trace.usage?.reasoningTokens ?? 0,
    costUsd: trace.usage?.costUsd ?? 0,
    fallbackUsed,
    budgetMiss: trace.budgetMiss === true,
  };
}

async function benchModel(
  entry: RosterModel,
  budgetMs: number,
  apiKey: string,
  reportCost: (cost: number) => void,
): Promise<ModelResult> {
  const traces: TraceEvent[] = [];
  let randomVoteWarnings = 0;
  const failures: Error[] = [];
  const logger: ModelPlayerLogger = {
    error: () => undefined,
    warn: (message) => {
      if (message.includes("randomly chose")) randomVoteWarnings += 1;
    },
  };
  const player = new ModelPlayer({
    model: entry.slug,
    displayName: entry.displayName,
    ...(entry.reasoning === null ? {} : { reasoning: entry.reasoning }),
    ...(entry.reasoningMandatory === undefined
      ? {}
      : { reasoningMandatory: entry.reasoningMandatory }),
    ...(entry.temperature === null ? {} : { temperature: entry.temperature }),
    apiKey,
    logger,
    sink: (event) => {
      if (event.type === "trace.completed") traces.push(event);
    },
    onFailure: (error) => failures.push(error),
  });
  const operations: OperationResult[] = [];

  console.error(`bench: starting ${entry.slug}`);
  for (const [promptIndex, fixture] of PROMPTS.entries()) {
    const answerTraceIndex = traces.length;
    const failureIndex = failures.length;
    const answer = await player.answer(fixture.prompt, {
      gameId: `bench-${entry.slug}-${promptIndex}`,
      round: 1,
      deadlineMs: Date.now() + budgetMs,
      maxLength: 45,
    });
    const answerTrace = traces[answerTraceIndex];
    if (!answerTrace) throw new Error(`${entry.slug} did not emit an answer trace`);
    const answerResult = operationFromTrace("answer", answerTrace, answer === DEFAULT_FALLBACK);
    operations.push(answerResult);
    reportCost(answerResult.costUsd);

    const immediateError = answerResult.fallbackUsed
      && failures.length > failureIndex
      && answerResult.totalMs < 5_000
      && (answerTrace.usage?.inputTokens ?? 0) === 0
      && (answerTrace.usage?.outputTokens ?? 0) === 0;
    if (immediateError) {
      console.error(`bench: skipping ${entry.slug} after immediate provider error`);
      return {
        entry,
        operations,
        skippedReason: failures.at(-1)?.message ?? "immediate provider error",
      };
    }

    const voteTraceIndex = traces.length;
    const warningIndex = randomVoteWarnings;
    await player.vote(fixture.prompt, [...fixture.voteOptions], {
      gameId: `bench-${entry.slug}-${promptIndex}`,
      round: 1,
      deadlineMs: Date.now() + budgetMs,
      maxLength: 45,
    });
    const voteTrace = traces[voteTraceIndex];
    if (!voteTrace) throw new Error(`${entry.slug} did not emit a vote trace`);
    const voteResult = operationFromTrace("vote", voteTrace, randomVoteWarnings > warningIndex);
    operations.push(voteResult);
    reportCost(voteResult.costUsd);
  }
  console.error(`bench: finished ${entry.slug}`);
  return { entry, operations };
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await callback(value);
    }
  });
  await Promise.all(workers);
  return results;
}

function failedBudget(result: ModelResult, budgetMs: number): boolean {
  if (result.skippedReason) return true;
  const misses = result.operations.filter((operation) => (
    operation.budgetMiss || operation.totalMs > budgetMs
  )).length;
  const answerP50 = percentile(
    result.operations.filter((operation) => operation.kind === "answer").map((operation) => operation.totalMs),
    0.5,
  );
  return misses > 2 || answerP50 > budgetMs;
}

function printTable(results: readonly ModelResult[], budgetMs: number): void {
  const rows = results.map((result) => {
    const totalTimes = result.operations.map((operation) => operation.totalMs);
    const firstTokenTimes = result.operations
      .map((operation) => operation.firstTokenMs)
      .filter((value) => value !== null);
    const reasoningTokens = result.operations.reduce(
      (sum, operation) => sum + operation.reasoningTokens,
      0,
    );
    const costUsd = result.operations.reduce((sum, operation) => sum + operation.costUsd, 0);
    const misses = result.operations.filter((operation) => (
      operation.budgetMiss || operation.totalMs > budgetMs
    )).length;
    return {
      model: result.entry.slug,
      "p50 total ms": result.skippedReason ? "ERROR" : percentile(totalTimes, 0.5),
      "max total ms": result.skippedReason ? "ERROR" : Math.max(0, ...totalTimes),
      "p50 first-token ms": firstTokenTimes.length === 0 ? "—" : percentile(firstTokenTimes, 0.5),
      "reasoning tokens": reasoningTokens,
      "cost USD": costUsd.toFixed(6),
      "miss rate": result.operations.length === 0
        ? "—"
        : `${misses}/${result.operations.length} (${(100 * misses / result.operations.length).toFixed(0)}%)`,
      result: failedBudget(result, budgetMs) ? "FAIL" : "PASS",
      ...(result.skippedReason === undefined ? {} : { note: result.skippedReason.slice(0, 80) }),
    };
  });
  console.table(rows);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const roster = await loadRoster();
  const entries = options.modelSlugs === undefined
    ? roster.models.filter((entry) => entry.enabled)
    : roster.models.filter((entry) => options.modelSlugs?.has(entry.slug));
  if (options.modelSlugs !== undefined) {
    const found = new Set(entries.map((entry) => entry.slug));
    const missing = [...options.modelSlugs].filter((slug) => !found.has(slug));
    if (missing.length > 0) throw new Error(`Unknown models: ${missing.join(", ")}`);
  }
  if (entries.length === 0) throw new Error("No models selected");

  let observedCostUsd = 0;
  const results = await mapConcurrent(entries, CONCURRENCY, async (entry) => {
    if (observedCostUsd >= SPEND_CAP_USD) {
      return { entry, operations: [], skippedReason: `spend cap $${SPEND_CAP_USD} reached` };
    }
    return benchModel(entry, options.budgetMs, apiKey, (cost) => {
      observedCostUsd += cost;
    });
  });
  printTable(results, options.budgetMs);
  const wouldBench = results.filter((result) => failedBudget(result, options.budgetMs));
  console.log(
    `Would be benched at ${options.budgetMs / 1_000}s: `
    + (wouldBench.length === 0 ? "none" : wouldBench.map((result) => result.entry.slug).join(", ")),
  );
  console.log(`Observed cost: $${observedCostUsd.toFixed(6)} (cap $${SPEND_CAP_USD.toFixed(2)})`);
}

await main();
