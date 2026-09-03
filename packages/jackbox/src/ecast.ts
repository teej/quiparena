import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import type { SeatCredentials } from "./credentials.js";
import type { RoomInfo } from "./room.js";

export type EntityType = "object" | "text" | "number" | string;

export interface EntityRecord<T = unknown> {
  type: EntityType;
  key: string;
  value: T;
  version?: number;
  from?: number;
  locked?: boolean;
  metadata?: Record<string, unknown>;
}

export interface EcastPresence {
  id?: number;
  roles?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EcastWelcome {
  id: number;
  name: string;
  secret: string;
  reconnect: boolean;
  deviceId: string;
  entities: Record<string, unknown>;
  here: Record<string, EcastPresence>;
  profile?: Record<string, unknown>;
  hostId: number;
}

export interface ReconnectPolicy {
  enabled?: boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
}

export interface EcastConnectionOptions {
  room: Pick<RoomInfo, "code" | "host" | "keepalive" | "controllerBranch" | "audienceEnabled">;
  name: string;
  userId?: string;
  credentials?: SeatCredentials;
  origin?: string;
  referer?: string;
  requestTimeoutMs?: number;
  reconnect?: ReconnectPolicy;
  recordFile?: string;
  /** Test/private-server escape hatch. Production callers should use the room host. */
  baseUrl?: string;
  webSocketOptions?: ClientOptions;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface EcastEventMap {
  welcome: [welcome: EcastWelcome];
  entity: [entity: EntityRecord];
  error: [error: Error];
  close: [code: number, reason: string];
  reconnecting: [attempt: number, delayMs: number];
  raw: [envelope: Record<string, unknown>];
}

interface EntityStoreEventMap {
  entity: [entity: EntityRecord];
  drop: [key: string];
}

export class EcastProtocolError extends Error {
  readonly code?: number | string;
  readonly result?: unknown;

  constructor(message: string, options: { code?: number | string; result?: unknown } = {}) {
    super(message);
    this.name = "EcastProtocolError";
    if (options.code !== undefined) this.code = options.code;
    if (options.result !== undefined) this.result = options.result;
  }
}

export class EntityStore extends EventEmitter<EntityStoreEventMap> {
  readonly #entities = new Map<string, EntityRecord>();

  get size(): number {
    return this.#entities.size;
  }

  get<T = unknown>(key: string): EntityRecord<T> | undefined {
    return this.#entities.get(key) as EntityRecord<T> | undefined;
  }

  value<T = unknown>(key: string): T | undefined {
    return this.get<T>(key)?.value;
  }

  values(): EntityRecord[] {
    return [...this.#entities.values()];
  }

  replaceSnapshot(snapshot: Record<string, unknown>): void {
    const replacements: EntityRecord[] = [];
    for (const [snapshotKey, tuple] of Object.entries(snapshot)) {
      const parsed = parseSnapshotEntity(snapshotKey, tuple);
      if (parsed) replacements.push(parsed);
    }
    this.#entities.clear();
    for (const entity of replacements) this.#entities.set(entity.key, entity);
    for (const entity of replacements) this.emit("entity", entity);
  }

  apply(opcode: string, result: unknown): EntityRecord | undefined {
    // UNVERIFIED: lock/drop and text/number notification shapes were not present in
    // the lobby recordings; implementations follow docs/ecast-protocol.md §3.
    if (opcode === "drop") {
      if (!isRecord(result) || typeof result.key !== "string") return undefined;
      if (this.#entities.delete(result.key)) this.emit("drop", result.key);
      return undefined;
    }

    if (opcode === "lock") {
      if (!isRecord(result) || typeof result.key !== "string") return undefined;
      const current = this.#entities.get(result.key);
      if (!current) return undefined;
      const next: EntityRecord = { ...current, locked: true };
      this.#entities.set(next.key, next);
      this.emit("entity", next);
      return next;
    }

    const type = entityTypeForOpcode(opcode);
    if (!type || !isRecord(result) || typeof result.key !== "string" || !("val" in result)) {
      return undefined;
    }

    const current = this.#entities.get(result.key);
    const version = typeof result.version === "number" ? result.version : undefined;
    if (version !== undefined && current?.version !== undefined && version <= current.version) {
      return undefined;
    }

    const metadata = Object.fromEntries(Object.entries(result).filter(([key]) => ![
      "key", "val", "version", "from",
    ].includes(key)));
    const next: EntityRecord = {
      type,
      key: result.key,
      value: result.val,
      ...(version === undefined ? {} : { version }),
      ...(typeof result.from === "number" ? { from: result.from } : {}),
      ...(current?.locked === undefined ? {} : { locked: current.locked }),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
    // Preserve reducer-like "last recognized alias wins" behavior for clients
    // that project room/player compatibility keys from values().
    this.#entities.delete(next.key);
    this.#entities.set(next.key, next);
    this.emit("entity", next);
    return next;
  }
}

export class EcastConnection extends EventEmitter<EcastEventMap> {
  readonly room: Pick<RoomInfo, "code" | "host" | "keepalive" | "controllerBranch" | "audienceEnabled">;
  readonly name: string;
  readonly userId: string;
  readonly entities = new EntityStore();

  #socket: WebSocket | undefined;
  #welcome: EcastWelcome | undefined;
  #seq = 0;
  #pc?: number;
  #pending = new Map<number, PendingRequest>();
  #manualClose = false;
  #roomExited = false;
  #everWelcomed = false;
  #reconnectAttempts = 0;
  #nextReconnectDelayMs: number | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #connectPromise: Promise<EcastWelcome> | undefined;
  #recording: Promise<void> = Promise.resolve();
  readonly #options: EcastConnectionOptions;

  constructor(options: EcastConnectionOptions) {
    super();
    this.#options = options;
    this.room = { ...options.room, code: options.room.code.toUpperCase() };
    this.name = options.name;
    this.userId = options.credentials?.userId ?? options.userId ?? randomUUID();
    this.entities.on("entity", (entity) => this.emit("entity", entity));
    // EventEmitter treats an unhandled error specially; transport errors are still
    // observable without making a diagnostic-only consumer crash.
    this.on("error", () => undefined);
  }

  get welcome(): EcastWelcome | undefined {
    return this.#welcome;
  }

  get pc(): number | undefined {
    return this.#pc;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN && this.#welcome !== undefined;
  }

  get credentials(): SeatCredentials | undefined {
    const welcome = this.#welcome;
    if (!welcome) return undefined;
    return {
      room: this.room.code,
      name: welcome.name,
      userId: this.userId,
      id: welcome.id,
      secret: welcome.secret,
      ...(this.room.controllerBranch ? { branch: this.room.controllerBranch } : {}),
      role: "player",
      // Available for an in-memory, same-page reconnect. saveCredentials omits it.
      deviceId: welcome.deviceId,
    };
  }

  async connect(): Promise<EcastWelcome> {
    if (this.connected && this.#welcome) return this.#welcome;
    if (this.#connectPromise) return this.#connectPromise;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#manualClose = false;
    this.#roomExited = false;
    this.#reconnectAttempts = 0;
    this.#nextReconnectDelayMs = undefined;
    const promise = this.#openSocket();
    this.#connectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#connectPromise === promise) this.#connectPromise = undefined;
    }
  }

  async request<TResult = unknown>(opcode: string, params: Record<string, unknown>): Promise<TResult> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Ecast socket is not open");
    const seq = ++this.#seq;
    const frame = JSON.stringify({ seq, opcode, params });
    const timeoutMs = this.#options.requestTimeoutMs ?? 10_000;

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(seq);
        reject(new EcastProtocolError(`${opcode} request ${seq} timed out`));
      }, timeoutMs);
      this.#pending.set(seq, { resolve, reject, timer });
    });

    this.#record("out", frame);
    try {
      socket.send(frame);
    } catch (error) {
      const pending = this.#pending.get(seq);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(seq);
        pending.reject(asError(error));
      }
    }
    return await response as TResult;
  }

  sendToHost<TResult = unknown>(body: Record<string, unknown>): Promise<TResult> {
    const welcome = this.#welcome;
    if (!welcome) return Promise.reject(new Error("Cannot send before client/welcome"));
    return this.request<TResult>("client/send", {
      from: welcome.id,
      to: welcome.hostId,
      body,
    });
  }

  async close(code = 1000, reason = "client close"): Promise<void> {
    this.#manualClose = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const socket = this.#socket;
    this.#rejectPending(new Error("Ecast connection closed"));
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close(code, reason);
        setTimeout(resolve, 1_000).unref();
      });
    }
    await this.flushRecording();
  }

  async flushRecording(): Promise<void> {
    await this.#recording;
  }

  #buildUrl(): string {
    const baseUrl = this.#options.baseUrl ?? `wss://${this.room.host}`;
    const url = new URL(`/api/v2/rooms/${encodeURIComponent(this.room.code)}/play`, baseUrl);
    url.searchParams.set("role", "player");
    url.searchParams.set("name", this.name);
    url.searchParams.set("format", "json");
    url.searchParams.set("user-id", this.userId);

    // UNVERIFIED: the recordings contain reconnect URLs, not a fresh-player URL;
    // the credentials-free form follows docs/ecast-protocol.md §2.
    const samePageReconnect = this.#welcome !== undefined;
    const credentials = samePageReconnect ? this.credentials : this.#options.credentials;
    if (credentials) {
      url.searchParams.set("id", String(credentials.id));
      url.searchParams.set("secret", credentials.secret);
      if (samePageReconnect && credentials.deviceId) {
        url.searchParams.set("device-id", credentials.deviceId);
      }
    }
    return url.toString();
  }

  #openSocket(): Promise<EcastWelcome> {
    return new Promise<EcastWelcome>((resolve, reject) => {
      const origin = this.#options.origin ?? "https://jackbox.tv";
      const socket = new WebSocket(this.#buildUrl(), "ecast-v0", {
        origin,
        headers: { Referer: this.#options.referer ?? "https://jackbox.tv/" },
        ...this.#options.webSocketOptions,
      });
      this.#socket = socket;
      let settled = false;

      socket.on("message", (data) => {
        try {
          const welcome = this.#handleMessage(data);
          if (welcome && !settled) {
            settled = true;
            resolve(welcome);
          }
        } catch (error) {
          const parsed = asError(error);
          this.emit("error", parsed);
          if (!settled) {
            settled = true;
            reject(parsed);
          }
        }
      });
      socket.on("error", (error) => {
        this.emit("error", error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      socket.on("unexpected-response", (_request, response) => {
        const error = new Error(`Ecast websocket returned HTTP ${response.statusCode}`);
        this.emit("error", error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      socket.on("close", (code, reasonBuffer) => {
        const reason = reasonBuffer.toString();
        if (!settled) {
          settled = true;
          reject(new Error(`Ecast socket closed before welcome (${code}${reason ? `: ${reason}` : ""})`));
        }
        this.#handleClose(socket, code, reason);
      });
      // ws automatically responds to WebSocket ping control frames with pong.
      // docs/ecast-protocol.md §7 establishes no JSON-level heartbeat.
      socket.on("ping", () => undefined);
    });
  }

  #handleMessage(data: RawData): EcastWelcome | undefined {
    const raw = data.toString();
    this.#record("in", raw);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new EcastProtocolError("Received a non-JSON ecast frame");
    }
    if (!isRecord(decoded) || typeof decoded.opcode !== "string") {
      throw new EcastProtocolError("Received an invalid ecast envelope", { result: decoded });
    }
    if (typeof decoded.pc === "number") this.#pc = decoded.pc;
    this.emit("raw", decoded);

    if (typeof decoded.re === "number") {
      this.#handleReply(decoded.re, decoded.opcode, decoded.result);
      return undefined;
    }

    if (decoded.opcode === "client/welcome") return this.#handleWelcome(decoded.result);
    if (decoded.opcode === "room/exit") {
      // UNVERIFIED: room/exit was not captured; behavior follows docs §3 and §7.
      this.#roomExited = true;
      void this.close(1000, "room exited");
      return undefined;
    }

    const entity = this.entities.apply(decoded.opcode, decoded.result);
    if (!entity && entityTypeForOpcode(decoded.opcode)) {
      this.emit("error", new EcastProtocolError(`Malformed ${decoded.opcode} entity frame`, {
        result: decoded.result,
      }));
    }
    return undefined;
  }

  #handleReply(re: number, opcode: string, result: unknown): void {
    const pending = this.#pending.get(re);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(re);
    if (opcode === "ok") {
      pending.resolve(result);
      return;
    }
    if (opcode === "error") {
      const details = isRecord(result) ? result : {};
      const message = typeof details.msg === "string" ? details.msg : `Ecast request ${re} failed`;
      const code = typeof details.code === "number" || typeof details.code === "string"
        ? details.code
        : undefined;
      pending.reject(new EcastProtocolError(message, {
        ...(code === undefined ? {} : { code }),
        result,
      }));
      return;
    }
    pending.reject(new EcastProtocolError(`Unexpected reply opcode ${opcode}`, { result }));
  }

  #handleWelcome(result: unknown): EcastWelcome {
    if (!isRecord(result) || typeof result.id !== "number" || typeof result.name !== "string"
      || typeof result.secret !== "string" || typeof result.deviceId !== "string") {
      throw new EcastProtocolError("Malformed client/welcome result", { result });
    }
    const entities = isRecord(result.entities) ? result.entities : {};
    const here = isRecord(result.here) ? result.here as Record<string, EcastPresence> : {};
    const welcome: EcastWelcome = {
      id: result.id,
      name: result.name,
      secret: result.secret,
      reconnect: result.reconnect === true,
      deviceId: result.deviceId,
      entities,
      here,
      ...(isRecord(result.profile) ? { profile: result.profile } : {}),
      hostId: findHostId(here),
    };
    this.entities.replaceSnapshot(entities);
    this.#welcome = welcome;
    this.#everWelcomed = true;
    this.#reconnectAttempts = 0;
    this.#nextReconnectDelayMs = undefined;
    this.emit("welcome", welcome);
    return welcome;
  }

  #handleClose(socket: WebSocket, code: number, reason: string): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.emit("close", code, reason);
    this.#rejectPending(new Error(`Ecast socket closed (${code}${reason ? `: ${reason}` : ""})`));
    // The official Quiplash controller automatically reconnects only abnormal
    // close 1006. Normal/no-status and every other close are terminal.
    if (this.#manualClose || this.#roomExited || !this.#everWelcomed || code !== 1006) return;

    const policy = this.#options.reconnect;
    if (policy?.enabled === false) return;
    const maxAttempts = policy?.maxAttempts ?? 6;
    if (this.#reconnectAttempts >= maxAttempts) {
      this.emit("error", new Error(`Ecast reconnect exhausted after ${maxAttempts} attempts`));
      return;
    }
    const attempt = ++this.#reconnectAttempts;
    const base = policy?.baseDelayMs ?? 1_000;
    const cap = policy?.maxDelayMs ?? 13_000;
    const jitter = policy?.jitterMs ?? 499;
    if (this.#nextReconnectDelayMs === undefined) {
      this.#nextReconnectDelayMs = Math.min(
        cap,
        base + (jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0),
      );
    }
    const delay = attempt === 1 ? 0 : this.#nextReconnectDelayMs;
    if (attempt > 1) this.#nextReconnectDelayMs = Math.min(cap, this.#nextReconnectDelayMs * 2);
    this.emit("reconnecting", attempt, delay);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#openSocket().catch((error: unknown) => {
        // A socket close normally schedules the next bounded attempt. This is only
        // needed for failures that never produce a close event.
        if (!this.#socket) this.emit("error", asError(error));
      });
    }, delay);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #record(dir: "in" | "out", data: string): void {
    const path = this.#options.recordFile;
    if (!path) return;
    const line = `${JSON.stringify({ t: Date.now(), dir, data })}\n`;
    this.#recording = this.#recording
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, "utf8");
      })
      .catch((error: unknown) => {
        this.emit("error", new Error(`Could not append ecast recording ${path}: ${asError(error).message}`));
      });
  }
}

function parseSnapshotEntity(snapshotKey: string, tuple: unknown): EntityRecord | undefined {
  if (!Array.isArray(tuple) || typeof tuple[0] !== "string" || !isRecord(tuple[1])) return undefined;
  const payload = tuple[1];
  const metadata = isRecord(tuple[2]) ? tuple[2] : {};
  const key = typeof payload.key === "string" ? payload.key : snapshotKey;
  const value = "val" in payload ? payload.val : "count" in payload ? payload.count : payload;
  return {
    type: tuple[0],
    key,
    value,
    ...(typeof payload.version === "number" ? { version: payload.version } : {}),
    ...(typeof payload.from === "number" ? { from: payload.from } : {}),
    ...(typeof metadata.locked === "boolean" ? { locked: metadata.locked } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function entityTypeForOpcode(opcode: string): "object" | "text" | "number" | undefined {
  const [type, operation] = opcode.split("/");
  if (type !== "object" && type !== "text" && type !== "number") return undefined;
  if (operation !== undefined && !["update", "set", "create"].includes(operation)) return undefined;
  return type;
}

function isEntityOpcode(opcode: string): boolean {
  return entityTypeForOpcode(opcode) !== undefined || opcode === "lock" || opcode === "drop";
}

function findHostId(here: Record<string, EcastPresence>): number {
  for (const [key, presence] of Object.entries(here)) {
    if (isRecord(presence.roles) && "host" in presence.roles) {
      if (typeof presence.id === "number") return presence.id;
      const numericKey = Number(key);
      if (Number.isInteger(numericKey)) return numericKey;
    }
  }
  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
