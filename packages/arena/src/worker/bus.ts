import type { AnyEvent } from "@quiparena/core";

export type WorkerEventSink = (event: AnyEvent) => void | Promise<void>;

export interface EventPublisher {
  emit(event: AnyEvent): void;
}

export interface WorkerBusLogger {
  error(message: string, error: unknown): void;
}

const DEFAULT_LOGGER: WorkerBusLogger = {
  error: (message, error) => console.error(message, error),
};

/** A tiny ordered, asynchronous event bus shared by every seat and worker sink. */
export class WorkerEventBus {
  readonly #listeners = new Set<WorkerEventSink>();
  readonly #logger: WorkerBusLogger;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: { logger?: WorkerBusLogger } = {}) {
    this.#logger = options.logger ?? DEFAULT_LOGGER;
  }

  on(listener: WorkerEventSink): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  addSink(sink: WorkerEventSink | { consume(event: AnyEvent): void | Promise<void> }): () => void {
    return this.on(typeof sink === "function" ? sink : (event) => sink.consume(event));
  }

  emit(event: AnyEvent): void {
    const listeners = [...this.#listeners];
    this.#pending = this.#pending.then(async () => {
      const results = await Promise.allSettled(listeners.map(async (listener) => listener(event)));
      results.forEach((result) => {
        if (result.status === "rejected") {
          this.#logger.error(`[quiparena/worker] ${event.type} sink failed`, result.reason);
        }
      });
    });
  }

  async flush(): Promise<void> {
    await this.#pending;
  }
}

export { WorkerEventBus as EventBus };
