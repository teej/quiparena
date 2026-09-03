import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { GameEvent, ObservedFinalStanding } from "@quiparena/core";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import { lookupRoom } from "./room.js";
import type { RoomInfo } from "./room.js";

const AUDIENCE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36";

type AudienceEvent = Extract<GameEvent, {
  type: "matchup.observed" | "scoreboard.observed" | "standings.observed" | "audience.votes" | "harness.error";
}>;

interface AudienceRoom {
  code: string;
  audienceEnabled?: boolean;
  audienceHost?: string;
}

interface AudienceCredentials {
  id: number;
  secret: string;
  deviceId?: string;
}

interface AudiencePresentation {
  prompt: string;
  answers: [string, string];
  choiceKeys: [string, string];
}

interface PendingFinalStandings {
  standings: ObservedFinalStanding[];
  raw: unknown;
  at: string;
}

export interface AudienceWelcome {
  id: number;
  name: string;
  secret: string;
  reconnect: boolean;
  deviceId?: string;
}

export interface AudienceReconnectPolicy {
  enabled?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
}

export interface AudienceObserverOptions {
  gameId: string;
  room: AudienceRoom;
  name?: string;
  userId?: string;
  origin?: string;
  referer?: string;
  reconnect?: AudienceReconnectPolicy;
  recordFile?: string;
  onEvent?: (event: AudienceEvent) => void;
  lookupRoom?: (code: string) => Promise<RoomInfo>;
  /** Test/private-server escape hatch. Production callers use audienceHost. */
  baseUrl?: string;
  webSocketOptions?: ClientOptions;
}

interface AudienceObserverEventMap {
  event: [event: AudienceEvent];
  welcome: [welcome: AudienceWelcome];
  raw: [envelope: Record<string, unknown>];
  close: [code: number, reason: string];
  reconnecting: [attempt: number, delayMs: number];
  error: [error: Error];
}

/**
 * A read-only Quiplash audience connection. It intentionally exposes no send
 * operation: WebSocket protocol pongs are the only outbound traffic it allows.
 */
export class AudienceObserver extends EventEmitter<AudienceObserverEventMap> {
  readonly gameId: string;
  readonly name: string;

  #room: AudienceRoom;
  #userId: string;
  #credentials: AudienceCredentials | undefined;
  #socket: WebSocket | undefined;
  #connectPromise: Promise<AudienceWelcome> | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempts = 0;
  #manualClose = false;
  #awaitingReplacement = false;
  #recording: Promise<void> = Promise.resolve();
  #presentation: AudiencePresentation | undefined;
  #scoreboardRound = 0;
  #pendingFinal: PendingFinalStandings | undefined;
  #finalObserved = false;
  readonly #scoreFingerprints = new Set<string>();
  readonly #matchupFingerprints = new Set<string>();
  readonly #options: AudienceObserverOptions;

  constructor(options: AudienceObserverOptions) {
    super();
    this.#options = options;
    this.gameId = options.gameId;
    this.name = options.name ?? "AUDIENCE";
    this.#userId = options.userId ?? randomUUID();
    this.#room = normalizeRoom(options.room);
    // Preserve Node EventEmitter's diagnostics without requiring every consumer
    // to register an error listener.
    this.on("error", () => undefined);
  }

  get roomCode(): string {
    return this.#room.code;
  }

  get userId(): string {
    return this.#userId;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN && this.#credentials !== undefined;
  }

  async connect(): Promise<AudienceWelcome> {
    if (this.connected && this.#credentials) return welcomeFrom(this.#credentials, this.name, true);
    if (this.#connectPromise) return this.#connectPromise;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#manualClose = false;
    this.#awaitingReplacement = false;
    const promise = this.#openSocket();
    this.#connectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#connectPromise === promise) this.#connectPromise = undefined;
    }
  }

  /** Stop observing permanently. */
  async close(code = 1000, reason = "audience observer close"): Promise<void> {
    this.#manualClose = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    await this.#closeSocket(code, reason);
    await this.flushRecording();
  }

  /**
   * Follow a replacement room supplied by the runner. A replacement starts a
   * fresh audience identity; reconnect credentials never cross room codes.
   */
  async replaceRoom(room: AudienceRoom | string): Promise<AudienceWelcome> {
    this.#awaitingReplacement = true;
    await this.#closeSocket(1000, "audience room replaced");
    const lookedUp = typeof room === "string"
      ? await (this.#options.lookupRoom ?? lookupRoom)(room.trim().toUpperCase())
      : room;
    this.#room = normalizeRoom(lookedUp);
    this.#userId = randomUUID();
    this.#credentials = undefined;
    this.#reconnectAttempts = 0;
    this.#presentation = undefined;
    this.#scoreboardRound = 0;
    this.#pendingFinal = undefined;
    this.#finalObserved = false;
    this.#scoreFingerprints.clear();
    this.#matchupFingerprints.clear();
    this.#awaitingReplacement = false;
    this.#manualClose = false;
    return await this.connect();
  }

  async flushRecording(): Promise<void> {
    await this.#recording;
  }

  /** Resolve once the narrated final standings arrive; reject if the room exits first. */
  waitForFinalStandings(): Promise<void> {
    if (this.#finalObserved) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const event = (value: AudienceEvent): void => {
        if (value.type !== "standings.observed") return;
        cleanup();
        resolve();
      };
      const close = (): void => {
        if (!this.#awaitingReplacement) return;
        cleanup();
        reject(new Error(`Audience room ${this.#room.code} exited before final standings`));
      };
      const cleanup = (): void => {
        this.off("event", event);
        this.off("close", close);
      };
      this.on("event", event);
      this.on("close", close);
    });
  }

  /** Parse one recorded inbound payload without opening a socket. */
  ingestFrame(data: string | Buffer, at: string | Date = new Date()): AudienceEvent[] {
    const timestamp = typeof at === "string" ? at : at.toISOString();
    const events: AudienceEvent[] = [];
    const rawText = data.toString();
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawText);
    } catch {
      this.#parseError("Audience frame was not JSON", rawText, timestamp, events);
      return events;
    }
    if (!isRecord(decoded) || typeof decoded.opcode !== "string") {
      this.#parseError("Audience frame was not an ecast envelope", decoded, timestamp, events);
      return events;
    }
    this.emit("raw", decoded);

    if (decoded.opcode === "client/welcome") {
      const result = isRecord(decoded.result) ? decoded.result : undefined;
      if (!result || typeof result.id !== "number" || typeof result.secret !== "string") {
        this.#parseError("Malformed audience welcome", decoded, timestamp, events);
        return events;
      }
      this.#credentials = {
        id: result.id,
        secret: result.secret,
        ...(typeof result.deviceId === "string" ? { deviceId: result.deviceId } : {}),
      };
      const welcome = welcomeFrom(
        this.#credentials,
        typeof result.name === "string" ? result.name : this.name,
        result.reconnect === true,
      );
      this.emit("welcome", welcome);
      const entities = isRecord(result.entities) ? result.entities : {};
      for (const [snapshotKey, tuple] of Object.entries(entities)) {
        const entity = snapshotEntity(snapshotKey, tuple);
        if (entity) this.#observeEntity(entity.key, entity.value, decoded, timestamp, events);
      }
      return events;
    }

    if (decoded.opcode === "room/exit") {
      this.#awaitingReplacement = true;
      const socket = this.#socket;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "room exited");
      return events;
    }

    if (decoded.opcode === "audience/count-group") {
      this.#observeCountGroup(decoded.result, decoded, timestamp, events);
      return events;
    }

    if (isEntityOpcode(decoded.opcode)) {
      const result = isRecord(decoded.result) ? decoded.result : undefined;
      if (!result || typeof result.key !== "string" || !("val" in result)) {
        this.#parseError(`Malformed ${decoded.opcode} audience entity`, decoded, timestamp, events);
        return events;
      }
      this.#observeEntity(result.key, parseJsonValue(result.val), decoded, timestamp, events);
    }
    return events;
  }

  async #openSocket(): Promise<AudienceWelcome> {
    if (!this.#options.baseUrl && this.#options.lookupRoom) {
      this.#room = normalizeRoom(await this.#options.lookupRoom(this.#room.code));
    }
    const webSocketOptions = this.#options.webSocketOptions;
    const socket = new WebSocket(this.#buildUrl(), "ecast-v0", {
      ...webSocketOptions,
      origin: webSocketOptions?.origin ?? this.#options.origin ?? "https://jackbox.tv",
      headers: {
        Referer: this.#options.referer ?? "https://jackbox.tv/",
        "User-Agent": AUDIENCE_USER_AGENT,
        ...webSocketOptions?.headers,
      },
    });
    this.#socket = socket;
    return await new Promise<AudienceWelcome>((resolve, reject) => {
      let settled = false;
      const welcome = (value: AudienceWelcome): void => {
        if (settled) return;
        settled = true;
        this.off("welcome", welcome);
        resolve(value);
      };
      this.on("welcome", welcome);
      socket.on("message", (data) => {
        const raw = rawDataBuffer(data).toString("utf8");
        this.#record(raw);
        this.ingestFrame(raw);
      });
      socket.on("error", (error) => {
        this.emit("error", error);
        if (!settled) {
          settled = true;
          this.off("welcome", welcome);
          reject(error);
        }
      });
      socket.on("unexpected-response", (_request, response) => {
        const error = new Error(`Audience websocket returned HTTP ${response.statusCode}`);
        this.emit("error", error);
        if (!settled) {
          settled = true;
          this.off("welcome", welcome);
          reject(error);
        }
      });
      socket.on("close", (code, reasonBuffer) => {
        this.off("welcome", welcome);
        if (!settled) {
          settled = true;
          reject(new Error(`Audience socket closed before welcome (${code})`));
        }
        this.#handleClose(socket, code, reasonBuffer.toString());
      });
      socket.on("ping", () => undefined);
    });
  }

  #buildUrl(): string {
    if (this.#room.audienceEnabled === false) {
      throw new Error(`Room ${this.#room.code} does not enable an audience`);
    }
    if (!this.#options.baseUrl && !this.#room.audienceHost) {
      throw new Error(`Room ${this.#room.code} has no audienceHost`);
    }
    const baseUrl = this.#options.baseUrl ?? `wss://${this.#room.audienceHost}`;
    const url = new URL(`/api/v2/audience/${encodeURIComponent(this.#room.code)}/play`, baseUrl);
    url.searchParams.set("role", "audience");
    url.searchParams.set("name", this.name);
    url.searchParams.set("format", "json");
    url.searchParams.set("user-id", this.#userId);
    if (this.#credentials) {
      url.searchParams.set("id", String(this.#credentials.id));
      url.searchParams.set("secret", this.#credentials.secret);
      if (this.#credentials.deviceId) url.searchParams.set("device-id", this.#credentials.deviceId);
    }
    return url.toString();
  }

  #handleClose(socket: WebSocket, code: number, reason: string): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.emit("close", code, reason);
    if (this.#manualClose || this.#awaitingReplacement || this.#options.reconnect?.enabled === false) return;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer || this.#manualClose || this.#awaitingReplacement) return;
    const attempt = ++this.#reconnectAttempts;
    const base = this.#options.reconnect?.baseDelayMs ?? 1_000;
    const cap = this.#options.reconnect?.maxDelayMs ?? 13_000;
    const jitter = this.#options.reconnect?.jitterMs ?? 499;
    const delay = attempt === 1
      ? 0
      : Math.min(cap, base * 2 ** (attempt - 2))
        + (jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0);
    this.emit("reconnecting", attempt, delay);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#openSocket().then(
        () => { this.#reconnectAttempts = 0; },
        (error: unknown) => {
          this.emit("error", asError(error));
          this.#scheduleReconnect();
        },
      );
    }, delay);
  }

  async #closeSocket(code: number, reason: string): Promise<void> {
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close(code, reason);
      setTimeout(resolve, 1_000).unref();
    });
  }

  #observeEntity(
    key: string,
    value: unknown,
    raw: unknown,
    at: string,
    events: AudienceEvent[],
  ): void {
    const record = isRecord(value) ? value : undefined;
    if (!record) return;
    const projection = key === "audiencePlayer" && isRecord(record.audience)
      ? record.audience
      : record;
    if (projection.state === "MakeSingleChoice") {
      const prompt = displayText(projection.prompt).replace(/\s*Vote for your favorite\s*$/i, "").trim();
      const choices = Array.isArray(projection.choices) ? projection.choices : [];
      const parsedChoices = choices.flatMap((choice, index) => {
        const candidate = isRecord(choice) ? choice : undefined;
        const answer = displayText(candidate?.html ?? candidate?.text ?? candidate?.label ?? choice);
        const choiceKey = candidate?.key;
        return answer && (typeof choiceKey === "string" || typeof choiceKey === "number")
          ? [{ answer, key: String(choiceKey) }]
          : answer ? [{ answer, key: String(index) }] : [];
      });
      if (!prompt || parsedChoices.length !== 2) {
        this.#parseError("Could not parse audience voting prompt and two answers", raw, at, events);
      } else {
        this.#presentation = {
          prompt,
          answers: [parsedChoices[0]!.answer, parsedChoices[1]!.answer],
          choiceKeys: [parsedChoices[0]!.key, parsedChoices[1]!.key],
        };
      }
    }

    const descriptions = Array.isArray(record.textDescriptions)
      ? record.textDescriptions.filter(isRecord)
      : [];
    if (descriptions.length === 0) return;
    this.#observeScores(descriptions, raw, at, events);
    this.#observeResults(descriptions, raw, at, events);
  }

  #observeCountGroup(
    result: unknown,
    raw: unknown,
    at: string,
    events: AudienceEvent[],
  ): void {
    const group = isRecord(result) ? result : undefined;
    const choices = isRecord(group?.choices) ? group.choices : undefined;
    const presentation = this.#presentation;
    if (!choices || !presentation) {
      this.#parseError("Could not associate audience count-group with a matchup", raw, at, events);
      return;
    }
    const counts = presentation.choiceKeys.map((key) => choices[key]);
    if (counts.some((count) => typeof count !== "number" || !Number.isFinite(count) || count < 0)) {
      this.#parseError("Audience count-group had invalid or missing answer buckets", raw, at, events);
      return;
    }
    this.#push({
      type: "audience.votes",
      gameId: this.gameId,
      prompt: presentation.prompt,
      counts: counts as number[],
      raw,
      at,
    }, events);
  }

  #observeResults(
    descriptions: Record<string, unknown>[],
    raw: unknown,
    at: string,
    events: AudienceEvent[],
  ): void {
    for (const description of descriptions) {
      if (String(description.category).toLocaleLowerCase("en-US") !== "vote") continue;
      const text = typeof description.text === "string" ? description.text.trim() : "";
      const presentation = this.#presentation;
      if (!text || !presentation) {
        this.#parseError("Could not associate narrated matchup result with its answers", raw, at, events);
        continue;
      }
      const parsed = parseMatchupResult(text, presentation.answers);
      if (!parsed) {
        this.#parseError(`Could not parse audience matchup narration: ${text}`, raw, at, events);
        continue;
      }
      const fingerprint = JSON.stringify([
        normalizeText(presentation.prompt),
        presentation.answers.map(normalizeText),
        parsed.winner,
        parsed.percentages,
      ]);
      if (this.#matchupFingerprints.has(fingerprint)) continue;
      this.#matchupFingerprints.add(fingerprint);
      this.#push({
        type: "matchup.observed",
        gameId: this.gameId,
        prompt: presentation.prompt,
        answers: presentation.answers,
        winner: parsed.winner,
        ...(parsed.percentages === undefined ? {} : { percentages: parsed.percentages }),
        raw,
        at,
      }, events);
    }
  }

  #observeScores(
    descriptions: Record<string, unknown>[],
    raw: unknown,
    at: string,
    events: AudienceEvent[],
  ): void {
    const scoreDescriptions = descriptions.filter((description) => (
      String(description.category).toLocaleLowerCase("en-US") === "score"
    ));
    if (scoreDescriptions.length > 0) {
      const standings = scoreDescriptions.map((description) => (
        typeof description.text === "string" ? parseStanding(description.text) : undefined
      ));
      if (standings.some((standing) => standing === undefined)) {
        this.#parseError("Could not parse one or more audience score narrations", raw, at, events);
      } else {
        const parsed = standings as ObservedFinalStanding[];
        const fingerprint = JSON.stringify(parsed);
        if (!this.#scoreFingerprints.has(fingerprint)) {
          this.#scoreFingerprints.add(fingerprint);
          if (this.#scoreboardRound < 2) {
            this.#scoreboardRound += 1;
            this.#push({
              type: "scoreboard.observed",
              gameId: this.gameId,
              round: this.#scoreboardRound as 1 | 2,
              standings: parsed.map(({ name, score }) => ({ name, score })),
              raw,
              at,
            }, events);
          } else {
            this.#pendingFinal = { standings: parsed, raw, at };
          }
        }
      }
    }

    for (const description of descriptions) {
      if (String(description.category).toLocaleLowerCase("en-US") !== "winner") continue;
      const text = typeof description.text === "string" ? description.text : "";
      const winner = parseWinner(text);
      if (!winner || !this.#pendingFinal) {
        this.#parseError(`Could not parse final audience standings: ${text}`, raw, at, events);
        continue;
      }
      const pending = this.#pendingFinal;
      const narrated = pending.standings.find((standing) => normalizeText(standing.name) === normalizeText(winner.name));
      if (!narrated || narrated.score !== winner.score) {
        this.#parseError("Audience winner narration did not match the final score list", raw, at, events);
        continue;
      }
      this.#finalObserved = true;
      this.#push({
        type: "standings.observed",
        gameId: this.gameId,
        standings: pending.standings,
        winner: narrated.name,
        raw: { standings: pending.raw, winner: raw },
        at,
      }, events);
      this.#pendingFinal = undefined;
    }
  }

  #parseError(message: string, raw: unknown, at: string, events: AudienceEvent[]): void {
    const stateKey = rawPc(raw);
    this.#push({
      type: "harness.error",
      gameId: this.gameId,
      reason: "audience-parse",
      message,
      ...(stateKey === undefined ? {} : { stateKey }),
      at,
    }, events);
  }

  #push(event: AudienceEvent, events: AudienceEvent[]): void {
    events.push(event);
    this.emit("event", event);
    this.#options.onEvent?.(event);
  }

  #record(data: string): void {
    if (!this.#options.recordFile) return;
    const line = `${JSON.stringify({ t: Date.now(), dir: "in", data })}\n`;
    this.#recording = this.#recording
      .then(async () => {
        await mkdir(dirname(this.#options.recordFile!), { recursive: true });
        await appendFile(this.#options.recordFile!, line, "utf8");
      })
      .catch((error: unknown) => {
        this.emit("error", new Error(`Could not record audience frame: ${asError(error).message}`));
      });
  }
}

function normalizeRoom(room: AudienceRoom): AudienceRoom {
  return { ...room, code: room.code.trim().toUpperCase() };
}

function welcomeFrom(
  credentials: AudienceCredentials,
  name: string,
  reconnect: boolean,
): AudienceWelcome {
  return {
    id: credentials.id,
    name,
    secret: credentials.secret,
    reconnect,
    ...(credentials.deviceId === undefined ? {} : { deviceId: credentials.deviceId }),
  };
}

function snapshotEntity(snapshotKey: string, tuple: unknown): { key: string; value: unknown } | undefined {
  if (!Array.isArray(tuple) || !isRecord(tuple[1])) return undefined;
  const payload = tuple[1];
  const key = typeof payload.key === "string" ? payload.key : snapshotKey;
  const value = "val" in payload ? payload.val : "count" in payload ? payload.count : payload;
  return { key, value: parseJsonValue(value) };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseMatchupResult(
  text: string,
  answers: readonly [string, string],
): { winner: 0 | 1 | "tie"; percentages?: [number, number] } | undefined {
  if (/^.+?\s+and\s+.+?\s+tied[!.]?$/i.test(text)) return { winner: "tie" };
  const patterns = [
    /^The\s+winning\s+quip\s+is\s+"([\s\S]+)"\s+by\s+[\s\S]+?\s+with\s+(\d+(?:\.\d+)?)\s+percent\s+of\s+the\s+vote[.!]?$/i,
    /^"([\s\S]+)"\s+by\s+[\s\S]+?\s+got\s+(?:a\s+)?quiplash\s+with\s+(\d+(?:\.\d+)?)\s+percent\s+of\s+the\s+vote[.!]?$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const winner = answers.findIndex((answer) => normalizeText(answer) === normalizeText(match[1] ?? ""));
    const percent = Number(match[2]);
    if ((winner !== 0 && winner !== 1) || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      return undefined;
    }
    const percentages: [number, number] = winner === 0
      ? [percent, 100 - percent]
      : [100 - percent, percent];
    return { winner, percentages };
  }
  return undefined;
}

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

function parseStanding(text: string): ObservedFinalStanding | undefined {
  const match = text.trim().match(/^(.+?)\s+is\s+([a-z]+|\d+(?:st|nd|rd|th))\s+with\s+([\d,]+)\s+points?[.!]?$/i);
  if (!match) return undefined;
  const ordinal = (match[2] ?? "").toLocaleLowerCase("en-US");
  const placement = ORDINALS[ordinal] ?? Number.parseInt(ordinal, 10);
  const score = Number((match[3] ?? "").replaceAll(",", ""));
  if (!Number.isInteger(placement) || placement < 1 || !Number.isFinite(score)) return undefined;
  return { name: match[1]!.trim(), score, placement };
}

function parseWinner(text: string): { name: string; score: number } | undefined {
  const match = text.trim().match(/^The\s+winner\s+is\s+(.+?)\s+with\s+([\d,]+)\s+points?[.!]?$/i);
  if (!match) return undefined;
  const score = Number((match[2] ?? "").replaceAll(",", ""));
  return Number.isFinite(score) ? { name: match[1]!.trim(), score } : undefined;
}

function displayText(value: unknown): string {
  let text = typeof value === "string" ? value : "";
  if (isRecord(value)) {
    const candidate = value.html ?? value.text ?? value.value;
    text = typeof candidate === "string" ? candidate : "";
  }
  return decodeHtml(text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li)>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, body: string) => {
    const lower = body.toLocaleLowerCase("en-US");
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " } as Record<string, string>)[lower]
      ?? entity;
  });
}

function normalizeText(value: string): string {
  return displayText(value).normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function isEntityOpcode(opcode: string): boolean {
  const [type, operation] = opcode.split("/");
  return (type === "object" || type === "text" || type === "number")
    && (operation === undefined || operation === "update" || operation === "set" || operation === "create");
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function rawPc(raw: unknown): string | undefined {
  return isRecord(raw) && typeof raw.pc === "number" ? `pc:${raw.pc}` : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
