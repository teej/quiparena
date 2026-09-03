import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { AnyEvent } from "@quiparena/core";
import WebSocket from "ws";

import type { ArenaDatabaseClient } from "../db/client.js";
import { Recorder } from "../recorder.js";

export interface WorkerSink {
  consume(event: AnyEvent): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export class DbSink implements WorkerSink {
  readonly recorder: Recorder;

  constructor(recorderOrDb: Recorder | ArenaDatabaseClient) {
    this.recorder = recorderOrDb instanceof Recorder ? recorderOrDb : new Recorder(recorderOrDb);
  }

  consume(event: AnyEvent): Promise<void> {
    return this.recorder.consume(event);
  }
}

export class JsonlSink implements WorkerSink {
  #pending: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  consume(event: AnyEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    this.#pending = this.#pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, "utf8");
    });
    return this.#pending;
  }

  flush(): Promise<void> {
    return this.#pending;
  }

  close(): Promise<void> {
    return this.flush();
  }
}

export interface IngestSinkLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface IngestSinkOptions {
  url?: string;
  token?: string;
  maxQueue?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  logger?: IngestSinkLogger;
}

const DEFAULT_INGEST_LOGGER: IngestSinkLogger = {
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

function ingestUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Ingest URL must use http(s) or ws(s)");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ingest";
  return url.toString();
}

/** Authenticated JSON-lines websocket sink with bounded buffering and reconnect. */
export class IngestSink implements WorkerSink {
  readonly url: string;
  readonly token: string;
  readonly maxQueue: number;
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly logger: IngestSinkLogger;
  #queue: string[] = [];
  #socket: WebSocket | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #attempts = 0;
  #closed = false;
  #connecting: Promise<void> | undefined;
  #dropped = 0;

  constructor(options: IngestSinkOptions = {}) {
    const rawUrl = options.url ?? process.env["WEB_INGEST_URL"];
    const token = options.token ?? process.env["INGEST_TOKEN"];
    if (!rawUrl) throw new Error("WEB_INGEST_URL is not set");
    if (!token) throw new Error("INGEST_TOKEN is not set");
    this.url = ingestUrl(rawUrl);
    this.token = token;
    this.maxQueue = options.maxQueue ?? 2_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15_000;
    this.logger = options.logger ?? DEFAULT_INGEST_LOGGER;
    if (!Number.isInteger(this.maxQueue) || this.maxQueue < 1) {
      throw new RangeError("maxQueue must be a positive integer");
    }
  }

  get queued(): number {
    return this.#queue.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  consume(event: AnyEvent): void {
    if (this.#closed) throw new Error("IngestSink is closed");
    if (this.#queue.length >= this.maxQueue) {
      this.#queue.shift();
      this.#dropped += 1;
      this.logger.warn(`[quiparena/worker] ingest queue full; dropped oldest event (${this.#dropped} total)`);
    }
    this.#queue.push(`${JSON.stringify(event)}\n`);
    void this.connect().catch((error: unknown) => {
      this.logger.error("[quiparena/worker] ingest connection failed", error);
    });
    this.#drain();
  }

  connect(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("IngestSink is closed"));
    if (this.#socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.#connecting) return this.#connecting;

    this.#connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      this.#socket = socket;
      let settled = false;
      socket.once("open", () => {
        settled = true;
        this.#attempts = 0;
        this.#connecting = undefined;
        resolve();
        this.#drain();
      });
      socket.on("error", (error) => {
        this.logger.error("[quiparena/worker] ingest websocket error", error);
        if (!settled) {
          settled = true;
          this.#connecting = undefined;
          reject(error);
        }
      });
      socket.once("close", () => {
        if (this.#socket === socket) this.#socket = undefined;
        if (!settled) {
          settled = true;
          this.#connecting = undefined;
          reject(new Error("Ingest websocket closed before opening"));
        }
        this.#scheduleReconnect();
      });
    });
    return this.#connecting;
  }

  async flush(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#queue.length > 0 || (this.#socket?.bufferedAmount ?? 0) > 0) {
      if (Date.now() >= deadline) {
        throw new Error(`IngestSink did not flush within ${timeoutMs}ms`);
      }
      if (!this.#closed) void this.connect().catch(() => undefined);
      this.#drain();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.flush();
    } finally {
      this.#closed = true;
      if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
      const socket = this.#socket;
      this.#socket = undefined;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.close(1000, "worker close");
          setTimeout(resolve, 1_000).unref();
        });
      }
    }
  }

  #drain(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (this.#queue.length > 0 && socket.readyState === WebSocket.OPEN) {
      const frame = this.#queue.shift();
      if (frame === undefined) return;
      try {
        socket.send(frame);
      } catch (error) {
        this.#queue.unshift(frame);
        this.logger.error("[quiparena/worker] could not send ingest event", error);
        return;
      }
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer || this.#queue.length === 0) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.#attempts);
    this.#attempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.connect().catch(() => undefined);
    }, delay);
  }
}
