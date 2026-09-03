import type { AnyEvent } from "@quiparena/core";

import type { LobbyModelBudgetMetrics } from "./lobby.js";

interface OperationTiming {
  answerLatencyMs?: number;
  missed: boolean;
  traceLatency: boolean;
}

/** Collects per-model budget outcomes while deduplicating trace and harness fallbacks. */
export class BudgetMissTracker {
  readonly #models = new Map<string, string>();
  readonly #operations = new Map<string, Map<string, Map<string, OperationTiming>>>();

  observe(event: AnyEvent): void {
    if (event.type === "player.joined" && event.player.modelId) {
      this.#models.set(this.#playerKey(event.gameId, event.player.id), event.player.modelId);
      return;
    }
    if (!("gameId" in event) || !event.gameId || !("playerId" in event) || !event.playerId) return;
    const modelSlug = this.#models.get(this.#playerKey(event.gameId, event.playerId));
    if (!modelSlug) return;

    if (event.type === "trace.completed") {
      const purpose = event.purpose ?? "answer";
      const operation = this.#operation(
        event.gameId,
        modelSlug,
        this.#promptKey(purpose, event.prompt),
      );
      if (event.budgetMiss) operation.missed = true;
      if (purpose !== "vote" && event.usage?.totalMs !== undefined) {
        operation.answerLatencyMs = event.usage.totalMs;
        operation.traceLatency = true;
      }
      return;
    }

    if (event.type === "answer.submitted") {
      const purpose = event.round === 3 ? "thriplash" : "answer";
      const operation = this.#operation(
        event.gameId,
        modelSlug,
        this.#promptKey(purpose, event.prompt),
      );
      if (event.budgetMiss) operation.missed = true;
      if (!operation.traceLatency) operation.answerLatencyMs = event.latencyMs;
      return;
    }

    if (event.type === "vote.cast") {
      const operation = this.#operation(
        event.gameId,
        modelSlug,
        this.#promptKey("vote", event.prompt),
      );
      if (event.budgetMiss) operation.missed = true;
      return;
    }

    if (event.type === "harness.error" && event.reason === "watchdog") {
      this.#operation(
        event.gameId,
        modelSlug,
        `watchdog:${event.stateKey ?? event.message}`,
      ).missed = true;
    }
  }

  metrics(gameId: string): Record<string, LobbyModelBudgetMetrics> {
    const byModel = this.#operations.get(gameId);
    if (!byModel) return {};
    return Object.fromEntries([...byModel].map(([modelSlug, operations]) => [modelSlug, {
      misses: [...operations.values()].filter((operation) => operation.missed).length,
      answerLatenciesMs: [...operations.values()].flatMap((operation) => (
        operation.answerLatencyMs === undefined ? [] : [operation.answerLatencyMs]
      )),
    }]));
  }

  #operation(gameId: string, modelSlug: string, key: string): OperationTiming {
    const byModel = this.#operations.get(gameId) ?? new Map<string, Map<string, OperationTiming>>();
    this.#operations.set(gameId, byModel);
    const operations = byModel.get(modelSlug) ?? new Map<string, OperationTiming>();
    byModel.set(modelSlug, operations);
    const operation = operations.get(key) ?? { missed: false, traceLatency: false };
    operations.set(key, operation);
    return operation;
  }

  #playerKey(gameId: string, playerId: string): string {
    return `${gameId}\0${playerId}`;
  }

  #promptKey(purpose: "answer" | "vote" | "thriplash", prompt: string): string {
    return `${purpose}:${prompt}`;
  }
}
