import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AnyEvent } from "@quiparena/core";
import WebSocket, { WebSocketServer } from "ws";

import { EcastConnection } from "./ecast.js";
import type { Player } from "./player.js";
import { Quiplash3Seat } from "./quiplash3.js";
import { ScriptedPlayer } from "./scripted-player.js";

export type ReplayState = "EnterSingleText" | "EnterTextList" | "MakeSingleChoice";

export interface ReplayCount {
  EnterSingleText: number;
  EnterTextList: number;
  MakeSingleChoice: number;
}

export interface ReplayOccurrence {
  state: ReplayState;
  prompt: string;
  version?: number;
  actionsSent: number;
}

export interface ReplaySeatReport {
  seat: string;
  file: string;
  statesSeen: ReplayCount;
  actionsSent: ReplayCount;
  missedStates: ReplayOccurrence[];
  extraActions: ReplayOccurrence[];
  unassignedActions: number;
  events: AnyEvent[];
  ok: boolean;
}

export interface ReplayRecordingOptions {
  player?: Player;
  /** Virtual latency added to every Player answer/vote result. */
  playerDelayMs?: number;
  gameId?: string;
  roomCode?: string;
}

export type ReplayDirectoryOptions = Omit<ReplayRecordingOptions, "player">;

interface RecordingRow {
  t: number;
  dir: "in" | "out";
  data: string;
}

interface EcastFrame {
  pc?: number;
  re?: number;
  seq?: number;
  opcode: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

interface TrackedOccurrence extends ReplayOccurrence {
  signature: string;
}

/**
 * Replays one recorded seat through the real ecast reducer and seat state
 * machine using a loopback websocket. No Jackbox service is contacted.
 */
export async function replayRecording(
  path: string,
  options: ReplayRecordingOptions = {},
): Promise<ReplaySeatReport> {
  const playerDelayMs = options.playerDelayMs ?? 0;
  if (!Number.isFinite(playerDelayMs) || playerDelayMs < 0) {
    throw new RangeError("playerDelayMs must be a non-negative number");
  }
  const rows = await readRows(path);
  const welcomeFrame = findWelcome(rows);
  const welcome = asRecord(welcomeFrame.result);
  if (!welcome || typeof welcome.id !== "number" || typeof welcome.name !== "string") {
    throw new Error(`Recording ${path} has a malformed client/welcome frame`);
  }

  const seatName = welcome.name;
  const replayClock = playerDelayMs > 0 ? new ReplayClock(welcomeRow(rows).t) : undefined;
  const sourcePlayer = options.player ?? new ScriptedPlayer(seatName, { voteOffset: welcome.id - 2 });
  const player = replayClock
    ? delayedPlayer(sourcePlayer, playerDelayMs, replayClock)
    : sourcePlayer;
  const events: AnyEvent[] = [];
  const tracker = new OccurrenceTracker(welcome.id);
  tracker.observeWelcome(welcome);
  let activeOccurrence = tracker.active;
  let unassignedActions = 0;
  let syntheticPc = 1_000_000;
  let serverSocket: WebSocket | undefined;

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Replay websocket did not bind a TCP port");
  }

  const connected = new Promise<void>((resolve) => {
    server.once("connection", (socket) => {
      serverSocket = socket;
      socket.on("message", (data) => {
        const frame = parseFrame(data.toString(), `${path} generated outbound frame`);
        const actionState = gameplayActionState(frame, activeOccurrence?.state);
        if (actionState) {
          if (activeOccurrence?.state === actionState) activeOccurrence.actionsSent += 1;
          else unassignedActions += 1;
        }
        if (typeof frame.seq === "number") {
          socket.send(JSON.stringify({
            pc: syntheticPc++,
            re: frame.seq,
            opcode: "ok",
            result: {},
          }));
        }
      });
      socket.send(JSON.stringify(welcomeFrame));
      resolve();
    });
  });

  const connection = new EcastConnection({
    room: {
      code: options.roomCode ?? roomCodeFromPath(path),
      host: "replay.invalid",
      keepalive: false,
    },
    name: seatName,
    userId: `replay-${seatName}`,
    baseUrl: `ws://127.0.0.1:${address.port}`,
    requestTimeoutMs: 1_000,
    reconnect: { enabled: false },
  });
  const seat = new Quiplash3Seat(connection, player, {
    gameId: options.gameId ?? `replay-${roomCodeFromPath(path)}`,
    timerSafetyMs: 0,
    onEvent: (event) => events.push(event),
    log: () => undefined,
  });

  try {
    const connecting = seat.connect();
    await connected;
    await connecting;
    await seat.waitForIdle();

    const firstWelcomeIndex = rows.findIndex((row) => row.dir === "in"
      && parseFrame(row.data, path).opcode === "client/welcome");
    for (const [index, row] of rows.entries()) {
      if (index <= firstWelcomeIndex) continue;
      const frame = parseFrame(row.data, path);
      // Recorded outbound gameplay rows are causal barriers: later inbound
      // completion/projection frames were produced by that action. Release the
      // virtual Player delay here so fast-forwarding cannot invert that order.
      if (replayClock && row.dir === "out" && gameplayActionState(frame, tracker.active?.state)) {
        replayClock.releaseNextDelay();
        await settleTransport();
      }
      if (row.dir !== "in") continue;
      if (typeof frame.re === "number" || frame.opcode === "room/exit") continue;

      if (replayClock) {
        replayClock.advanceTo(row.t);
        await settleTransport();
      }

      tracker.observeFrame(frame);
      activeOccurrence = tracker.active;
      const socket = serverSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error(`Replay socket closed while reading ${path}`);
      }
      const observed = waitForRaw(connection, frame);
      socket.send(row.data);
      await observed;
      if (replayClock) {
        await settleTransport();
      } else {
        await seat.waitForIdle();
      }
    }
    if (replayClock) {
      replayClock.flush();
      await settleTransport();
      await seat.waitForIdle();
    }
  } finally {
    await connection.close();
    await closeServer(server);
  }

  const statesSeen = emptyCounts();
  const actionsSent = emptyCounts();
  for (const occurrence of tracker.occurrences) {
    statesSeen[occurrence.state] += 1;
    actionsSent[occurrence.state] += occurrence.actionsSent;
  }
  const missedStates = tracker.occurrences.filter((occurrence) => occurrence.actionsSent === 0);
  const extraActions = tracker.occurrences.filter((occurrence) => occurrence.actionsSent > 1);
  return {
    seat: seatName,
    file: path,
    statesSeen,
    actionsSent,
    missedStates: missedStates.map(publicOccurrence),
    extraActions: extraActions.map(publicOccurrence),
    unassignedActions,
    events,
    ok: missedStates.length === 0 && extraActions.length === 0 && unassignedActions === 0,
  };
}

/** Replay every `*.jsonl` seat recording in a directory, never other files. */
export async function replayDirectory(
  dir: string,
  options: ReplayDirectoryOptions = {},
): Promise<ReplaySeatReport[]> {
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort(numericSort);
  if (files.length === 0) throw new Error(`Replay directory ${dir} contains no JSONL recordings`);
  return await Promise.all(files.map(async (file) => replayRecording(join(dir, file), options)));
}

class ReplayClock {
  #now: number;
  #delays: Array<{ dueAt: number; resolve: () => void }> = [];
  #flushed = false;

  constructor(now: number) {
    this.#now = now;
  }

  delay(ms: number): Promise<void> {
    if (ms <= 0 || this.#flushed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#delays.push({ dueAt: this.#now + ms, resolve });
      this.#delays.sort((left, right) => left.dueAt - right.dueAt);
    });
  }

  advanceTo(now: number): void {
    this.#now = Math.max(this.#now, now);
    this.#resolveDue();
  }

  releaseNextDelay(): void {
    const next = this.#delays[0];
    if (!next) return;
    this.#now = Math.max(this.#now, next.dueAt);
    this.#resolveDue();
  }

  flush(): void {
    this.#flushed = true;
    this.#now = Number.POSITIVE_INFINITY;
    this.#resolveDue();
  }

  #resolveDue(): void {
    while (this.#delays[0] && this.#delays[0].dueAt <= this.#now) {
      this.#delays.shift()?.resolve();
    }
  }
}

function delayedPlayer(player: Player, delayMs: number, clock: ReplayClock): Player {
  const resolveAfterDelay = async <T>(work: () => Promise<T>): Promise<T> => {
    const value = await work();
    await clock.delay(delayMs);
    return value;
  };
  return {
    name: player.name,
    modelId: player.modelId,
    answer: (prompt, context) => resolveAfterDelay(() => player.answer(prompt, context)),
    answerFinal: (prompt, context) => resolveAfterDelay(() => player.answerFinal(prompt, context)),
    vote: (prompt, choices, context) => resolveAfterDelay(() => player.vote(prompt, choices, context)),
  };
}

class OccurrenceTracker {
  readonly occurrences: TrackedOccurrence[] = [];
  active: TrackedOccurrence | undefined;
  readonly #playerKeys: Set<string>;

  constructor(playerId: number) {
    this.#playerKeys = new Set(["player", `player:${playerId}`]);
  }

  observeWelcome(welcome: Record<string, unknown>): void {
    const entities = asRecord(welcome.entities) ?? {};
    for (const [snapshotKey, tuple] of Object.entries(entities)) {
      if (!this.#playerKeys.has(snapshotKey) || !Array.isArray(tuple)) continue;
      const payload = asRecord(tuple[1]);
      if (!payload) continue;
      this.#observeValue("val" in payload ? payload.val : payload, numberValue(payload.version));
    }
  }

  observeFrame(frame: EcastFrame): void {
    const result = asRecord(frame.result);
    if (!result || typeof result.key !== "string" || !this.#playerKeys.has(result.key)) return;
    if (frame.opcode === "drop") {
      this.active = undefined;
      return;
    }
    if (!["object", "object/update", "object/set", "object/create", "text", "text/update", "text/set", "text/create"]
      .includes(frame.opcode)) return;
    this.#observeValue(result.val, numberValue(result.version));
  }

  #observeValue(value: unknown, version?: number): void {
    const state = recordValue(value);
    const kind = replayState(state.state);
    if (!kind || isComplete(kind, state)) {
      this.active = undefined;
      return;
    }
    const prompt = extractDisplayText(state.prompt);
    if (!prompt || (kind === "MakeSingleChoice" && projectChoiceCount(state.choices) === 0)) {
      this.active = undefined;
      return;
    }
    const signature = occurrenceSignature(kind, state, prompt);
    if (this.active?.signature === signature) return;
    const occurrence: TrackedOccurrence = {
      state: kind,
      prompt,
      ...(version === undefined ? {} : { version }),
      actionsSent: 0,
      signature,
    };
    this.occurrences.push(occurrence);
    this.active = occurrence;
  }
}

function occurrenceSignature(
  state: ReplayState,
  value: Record<string, unknown>,
  prompt: string,
): string {
  if (state === "MakeSingleChoice") {
    return JSON.stringify([state, value.choiceId, prompt, value.choices]);
  }
  return JSON.stringify([state, value.entryId, value.textKey, prompt]);
}

function isComplete(state: ReplayState, value: Record<string, unknown>): boolean {
  if (state === "EnterSingleText") return Boolean(value.entry);
  if (state === "EnterTextList") return Boolean(value.entries);
  return value.chosen !== null && value.chosen !== undefined && value.chosen !== "";
}

function gameplayActionState(
  frame: EcastFrame,
  activeState?: ReplayState,
): ReplayState | undefined {
  if (frame.opcode === "text/update") {
    return activeState === "EnterTextList" ? "EnterTextList" : "EnterSingleText";
  }
  if (frame.opcode !== "client/send") return undefined;
  const body = asRecord(frame.params?.body);
  if (body?.action === "choose") return "MakeSingleChoice";
  if (body?.action === "safetyQuip") return "EnterSingleText";
  if (body?.action === "write") return Array.isArray(body.entries)
    ? "EnterTextList"
    : "EnterSingleText";
  return undefined;
}

function waitForRaw(connection: EcastConnection, expected: EcastFrame): Promise<void> {
  return new Promise<void>((resolve) => {
    const handler = (actual: Record<string, unknown>): void => {
      if (actual.pc !== expected.pc || actual.opcode !== expected.opcode) return;
      connection.off("raw", handler);
      resolve();
    };
    connection.on("raw", handler);
  });
}

async function readRows(path: string): Promise<RecordingRow[]> {
  const contents = await readFile(path, "utf8");
  const rows = contents.split("\n").filter(Boolean).map((line, index): RecordingRow => {
    const decoded: unknown = JSON.parse(line);
    if (!isRecord(decoded) || typeof decoded.t !== "number"
      || (decoded.dir !== "in" && decoded.dir !== "out") || typeof decoded.data !== "string") {
      throw new Error(`Recording ${path} has an invalid row at line ${index + 1}`);
    }
    return { t: decoded.t, dir: decoded.dir, data: decoded.data };
  });
  if (rows.length === 0) throw new Error(`Recording ${path} is empty`);
  return rows;
}

function findWelcome(rows: readonly RecordingRow[]): EcastFrame {
  return parseFrame(welcomeRow(rows).data, "recording");
}

function welcomeRow(rows: readonly RecordingRow[]): RecordingRow {
  for (const row of rows) {
    if (row.dir !== "in") continue;
    const frame = parseFrame(row.data, "recording");
    if (frame.opcode === "client/welcome") return row;
  }
  throw new Error("Recording has no inbound client/welcome frame");
}

function parseFrame(data: string, label: string): EcastFrame {
  const decoded: unknown = JSON.parse(data);
  if (!isRecord(decoded) || typeof decoded.opcode !== "string") {
    throw new Error(`${label} is not an ecast frame`);
  }
  return decoded as unknown as EcastFrame;
}

function replayState(value: unknown): ReplayState | undefined {
  return value === "EnterSingleText" || value === "EnterTextList" || value === "MakeSingleChoice"
    ? value
    : undefined;
}

function extractDisplayText(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    const record = asRecord(value);
    const candidate = record?.html ?? record?.text ?? record?.value;
    text = typeof candidate === "string" ? candidate : "";
  }
  return decodeHtml(text
    .replace(/<[^>]*class=["'][^"']*header[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/^Prompt\s+\d+\s+of\s+\d+\s*/i, "")
    .trim();
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " } as Record<string, string>)[lower]
      ?? entity;
  });
}

function projectChoiceCount(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((candidate) => {
    if (typeof candidate === "string") return candidate.length > 0;
    const choice = asRecord(candidate);
    return choice !== undefined && choice.disabled !== true && choice.visible !== false
      && extractDisplayText(choice.html ?? choice.text ?? choice.label ?? choice.value).length > 0;
  }).length;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(value) ?? {};
}

function emptyCounts(): ReplayCount {
  return { EnterSingleText: 0, EnterTextList: 0, MakeSingleChoice: 0 };
}

function publicOccurrence(occurrence: TrackedOccurrence): ReplayOccurrence {
  return {
    state: occurrence.state,
    prompt: occurrence.prompt,
    ...(occurrence.version === undefined ? {} : { version: occurrence.version }),
    actionsSent: occurrence.actionsSent,
  };
}

function roomCodeFromPath(path: string): string {
  return basename(join(path, ".."), "-1").slice(0, 4).toUpperCase() || "TEST";
}

function numericSort(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined;
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function settleTransport(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
