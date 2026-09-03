import { EventEmitter } from "node:events";

import type { AnyEvent, GameEvent, RoundNumber } from "@quiparena/core";

import { EcastConnection, EcastProtocolError, type EcastWelcome, type EntityRecord } from "./ecast.js";
import type { Player, PlayerContext } from "./player.js";

export type PostGameAction = "newPlayers" | "samePlayers" | "none";

export interface Quiplash3SeatOptions {
  gameId: string;
  defaultAnswerTimeoutMs?: number;
  defaultVoteTimeoutMs?: number;
  timerSafetyMs?: number;
  autoStart?: boolean;
  postGameAction?: PostGameAction;
  onEvent?: (event: AnyEvent) => void;
  log?: (message: string, raw?: unknown) => void;
  now?: () => number;
}

interface Quiplash3SeatEventMap {
  event: [event: AnyEvent];
}

interface ChoiceProjection {
  label: string;
  runtimeId: unknown;
}

interface DeadlineResult<T> {
  value: T;
  latencyMs: number;
  fallback: boolean;
}

export class Quiplash3Seat extends EventEmitter<Quiplash3SeatEventMap> {
  readonly connection: EcastConnection;
  readonly player: Player;
  readonly gameId: string;

  #actions: Promise<void> = Promise.resolve();
  #created = false;
  #started = false;
  #ended = false;
  #avatarAttempted = false;
  #startAttempted = false;
  #postGameAttempted = false;
  #normalAnswerCount = 0;
  #round?: RoundNumber;
  #handledEntries = new Set<string>();
  #normalEntriesSeen = new Set<string>();
  #handledChoices = new Set<string>();
  #resolveEnded!: () => void;
  readonly #endedPromise: Promise<void>;
  readonly #options: Required<Pick<Quiplash3SeatOptions,
    "defaultAnswerTimeoutMs" | "defaultVoteTimeoutMs" | "timerSafetyMs" | "autoStart" | "postGameAction">>
    & Pick<Quiplash3SeatOptions, "onEvent" | "log">;
  readonly #now: () => number;

  constructor(connection: EcastConnection, player: Player, options: Quiplash3SeatOptions) {
    super();
    this.connection = connection;
    this.player = player;
    this.gameId = options.gameId;
    this.#now = options.now ?? Date.now;
    this.#options = {
      defaultAnswerTimeoutMs: options.defaultAnswerTimeoutMs ?? 60_000,
      defaultVoteTimeoutMs: options.defaultVoteTimeoutMs ?? 15_000,
      timerSafetyMs: options.timerSafetyMs ?? 750,
      autoStart: options.autoStart ?? false,
      postGameAction: options.postGameAction ?? "none",
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.log ? { log: options.log } : {}),
    };
    this.#endedPromise = new Promise<void>((resolve) => {
      this.#resolveEnded = resolve;
    });

    connection.on("welcome", (welcome) => {
      this.#observeWelcome(welcome);
      void this.#enqueueState();
    });
    connection.on("entity", () => void this.#enqueueState());
    connection.on("error", (error) => this.#reportError(error));
    connection.on("close", (code, reason) => {
      if (!this.#ended && code !== 1000 && code !== 1005) {
        this.#reportError(new Error(`Ecast connection closed (${code}${reason ? `: ${reason}` : ""})`));
      }
    });
  }

  get playerId(): string | undefined {
    return this.connection.welcome ? String(this.connection.welcome.id) : undefined;
  }

  get isVip(): boolean {
    return this.#view().merged.playerIsVIP === true;
  }

  get canStart(): boolean {
    return isStartable(this.#view().merged);
  }

  get hasAvatar(): boolean {
    return typeof asRecord(this.#view().merged.playerInfo)?.avatar === "string";
  }

  async connect(): Promise<EcastWelcome> {
    const welcome = await this.connection.connect();
    await this.#enqueueState();
    return welcome;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  waitForGameEnd(): Promise<void> {
    return this.#endedPromise;
  }

  async waitUntilCanStart(timeoutMs = 30_000): Promise<void> {
    await this.#waitUntil(() => this.canStart, "become able to start", timeoutMs);
  }

  async waitUntilAvatarSelected(timeoutMs = 10_000): Promise<void> {
    await this.#waitUntil(() => this.hasAvatar, "receive its selected avatar", timeoutMs);
  }

  async #waitUntil(predicate: () => boolean, description: string, timeoutMs: number): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (!predicate()) return;
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.connection.off("entity", check);
        this.connection.off("welcome", check);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.player.name} did not ${description} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.connection.on("entity", check);
      this.connection.on("welcome", check);
      check();
    });
  }

  async startIfVip(): Promise<boolean> {
    let started = false;
    await this.#enqueue(async () => {
      const raw = this.#view();
      if (!isStartable(raw.merged)) return;
      await this.#start(raw);
      started = true;
    });
    return started;
  }

  #observeWelcome(welcome: EcastWelcome): void {
    if (this.#created) return;
    this.#created = true;
    this.#emitEvent({
      type: "game.created",
      gameId: this.gameId,
      roomCode: this.connection.room.code,
      at: this.#at(),
    });
    this.#emitEvent({
      type: "player.joined",
      gameId: this.gameId,
      player: { id: String(welcome.id), name: welcome.name, modelId: this.player.modelId },
      at: this.#at(),
    });
  }

  #enqueueState(): Promise<void> {
    return this.#enqueue(() => this.#processState());
  }

  #enqueue(action: () => Promise<void> | void): Promise<void> {
    this.#actions = this.#actions
      .then(action)
      .catch((error: unknown) => this.#reportError(asError(error)));
    return this.#actions;
  }

  async #processState(): Promise<void> {
    const welcome = this.connection.welcome;
    if (!welcome) return;
    const raw = this.#view();
    const state = typeof raw.merged.state === "string" ? raw.merged.state : undefined;

    if (!this.#started && (raw.merged.gameIsStarting === true || (state !== undefined && state !== "Lobby"))) {
      this.#started = true;
      this.#emitEvent({ type: "game.started", gameId: this.gameId, at: this.#at() });
    }

    // UNVERIFIED: all game-phase incoming state shapes are from docs/ecast-protocol.md §4;
    // the real recordings stop in Lobby. Each handler validates only what it uses.
    switch (state) {
      case "Lobby":
        await this.#handleLobby(raw);
        break;
      case "EnterSingleText":
        await this.#handleSingleAnswer(raw);
        break;
      case "EnterTextList":
        await this.#handleThriplash(raw);
        break;
      case "MakeSingleChoice":
        await this.#handleVote(raw);
        break;
      default:
        // Logo, Gameplay_Logo, and other interstitial layouts are passive.
        break;
    }
  }

  async #handleLobby(raw: StateView): Promise<void> {
    const state = raw.merged;
    if (state.gameFinished === true) {
      if (!this.#ended) {
        this.#ended = true;
        const finalScores = parseScores(state.finalScores ?? state.scores);
        this.#emitEvent({
          type: "game.ended",
          gameId: this.gameId,
          ...(finalScores ? { finalScores } : {}),
          at: this.#at(),
        });
      }
      try {
        await this.#postGame(raw);
      } finally {
        this.#resolveEnded();
      }
      return;
    }

    const playerInfo = asRecord(state.playerInfo);
    if (!this.#avatarAttempted && typeof playerInfo?.avatar !== "string") {
      const characters = Array.isArray(state.characters) ? state.characters : [];
      const available = characters.find((character) => {
        const item = asRecord(character);
        return item?.available === true && typeof item.name === "string";
      });
      const character = asRecord(available);
      if (typeof character?.name === "string") {
        this.#avatarAttempted = true;
        try {
          // Avatar selection and its successful acknowledgement are verified by RECX2.jsonl.
          await this.connection.sendToHost({ action: "avatar", name: character.name });
        } catch (error) {
          this.#avatarAttempted = false;
          this.#logRaw("Avatar selection failed", raw, error);
          throw error;
        }
      }
    }

    if (this.#options.autoStart && isStartable(state)) await this.#start(raw);
  }

  async #start(raw: StateView): Promise<void> {
    if (this.#startAttempted) return;
    this.#startAttempted = true;
    try {
      // UNVERIFIED: a correct-VIP successful start was not recorded; shape is from §4
      // (REC1 contains this body with a spoofed `from`, which the server rejected).
      await this.connection.sendToHost({ action: "start" });
    } catch (error) {
      this.#startAttempted = false;
      this.#logRaw("VIP start was rejected", raw, error);
      throw error;
    }
  }

  async #handleSingleAnswer(raw: StateView): Promise<void> {
    const state = raw.merged;
    if (state.entry !== null && state.entry !== undefined) return;
    const prompt = extractPrompt(state.prompt);
    const token = entryToken(state, raw.playerEntity);
    if (this.#handledEntries.has(token)) return;
    if (!prompt) {
      this.#logRaw("EnterSingleText did not contain a usable prompt", raw);
      return;
    }
    this.#handledEntries.add(token);
    if (!this.#normalEntriesSeen.has(token)) {
      this.#normalEntriesSeen.add(token);
      this.#normalAnswerCount += 1;
    }

    const round = this.#observeRound(inferRound(
      state,
      "EnterSingleText",
      this.#round,
      this.#normalAnswerCount,
    ));
    const deadlineMs = computeDeadlineMs(
      state,
      this.#now(),
      this.#options.defaultAnswerTimeoutMs,
      this.#options.timerSafetyMs,
    );
    const playerId = this.#requirePlayerId();
    this.#emitEvent({
      type: "prompt.dealt",
      gameId: this.gameId,
      round,
      playerId,
      prompt,
      deadlineMs,
      at: this.#at(),
    });

    const result = await this.#beforeDeadline(
      () => this.player.answer(prompt, this.#context(round, prompt, deadlineMs)),
      deadlineMs,
      "",
    );
    const answer = cleanLine(result.value, numeric(state.maxLength));
    try {
      await this.#submitSingleAnswer(state, answer, raw);
      this.#emitEvent({
        type: "answer.submitted",
        gameId: this.gameId,
        round,
        playerId,
        prompt,
        answer,
        blank: result.fallback || answer.trim().length === 0,
        latencyMs: result.latencyMs,
        at: this.#at(),
      });
    } catch (error) {
      this.#handledEntries.delete(token);
      this.#logRaw("Single-answer submission failed", raw, error);
      this.#reportError(asError(error));
    }
  }

  async #submitSingleAnswer(state: Record<string, unknown>, answer: string, raw: StateView): Promise<void> {
    if (typeof state.textKey === "string" && state.textKey) {
      // UNVERIFIED: text/update answer send is from docs/ecast-protocol.md §4.
      await this.connection.request("text/update", { key: state.textKey, val: answer });
      return;
    }
    this.#logRaw("EnterSingleText has no textKey; using the unverified host fallback", raw);
    // UNVERIFIED: no-textKey fallback is explicitly uncertain in docs §4.
    await this.connection.sendToHost({ action: "write", entry: answer });
  }

  async #handleThriplash(raw: StateView): Promise<void> {
    const state = raw.merged;
    if (state.entries !== null && state.entries !== undefined) return;
    const prompt = extractPrompt(state.prompt);
    const token = entryToken(state, raw.playerEntity);
    if (this.#handledEntries.has(token)) return;
    if (!prompt) {
      this.#logRaw("EnterTextList did not contain a usable prompt", raw);
      return;
    }
    this.#handledEntries.add(token);

    const round = this.#observeRound(3);
    const deadlineMs = computeDeadlineMs(
      state,
      this.#now(),
      this.#options.defaultAnswerTimeoutMs,
      this.#options.timerSafetyMs,
    );
    const playerId = this.#requirePlayerId();
    this.#emitEvent({
      type: "prompt.dealt",
      gameId: this.gameId,
      round,
      playerId,
      prompt,
      deadlineMs,
      at: this.#at(),
    });

    const result = await this.#beforeDeadline(
      () => this.player.answerFinal(prompt, this.#context(round, prompt, deadlineMs)),
      deadlineMs,
      ["", "", ""] as [string, string, string],
    );
    const maxLength = numeric(state.maxLength);
    let answers: [string, string, string] = [
      cleanLine(result.value[0], maxLength),
      cleanLine(result.value[1], maxLength),
      cleanLine(result.value[2], maxLength),
    ];

    try {
      answers = await this.#submitThriplash(state, answers, raw, deadlineMs);
      this.#emitEvent({
        type: "answer.submitted",
        gameId: this.gameId,
        round,
        playerId,
        prompt,
        answer: answers,
        blank: result.fallback || answers.every((answer) => answer.trim().length === 0),
        latencyMs: result.latencyMs,
        at: this.#at(),
      });
    } catch (error) {
      this.#handledEntries.delete(token);
      this.#logRaw("Thriplash submission failed", raw, error);
      this.#reportError(asError(error));
    }
  }

  async #submitThriplash(
    state: Record<string, unknown>,
    initialAnswers: [string, string, string],
    raw: StateView,
    deadlineMs: number,
  ): Promise<[string, string, string]> {
    const configuredCount = numeric(state.fieldCount);
    const fieldCount = configuredCount && configuredCount > 0 ? Math.floor(configuredCount) : 3;
    if (fieldCount !== 3) this.#logRaw(`Thriplash fieldCount was ${fieldCount}, expected 3`, raw);
    let answers = initialAnswers;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fields = [...answers].slice(0, fieldCount);
      while (fields.length < fieldCount) fields.push("");
      try {
        if (typeof state.textKey === "string" && state.textKey) {
          // UNVERIFIED: newline-delimited Thriplash text/update is from docs §4.
          await this.connection.request("text/update", { key: state.textKey, val: fields.join("\n") });
        } else {
          this.#logRaw("EnterTextList has no textKey; using the unverified host fallback", raw);
          // UNVERIFIED: no-textKey final fallback is explicitly uncertain in docs §4.
          await this.connection.sendToHost({ action: "write", entries: fields });
        }
        return answers;
      } catch (error) {
        if (!isDuplicateAnswerError(error) || attempt === 2 || this.#now() >= deadlineMs) throw error;
        // UNVERIFIED: duplicate-answer error wording was not recorded; the retry keeps
        // the docs §4 newline-delimited submission and varies each line defensively.
        answers = variantAnswers(answers, attempt + 1, numeric(state.maxLength));
      }
    }
    return answers;
  }

  async #handleVote(raw: StateView): Promise<void> {
    const state = raw.merged;
    if (state.chosen !== null && state.chosen !== undefined) return;
    const prompt = extractPrompt(state.prompt);
    const choices = projectChoices(state.choices);
    const token = choiceToken(state, raw.playerEntity, choices);
    if (this.#handledChoices.has(token)) return;
    if (!prompt || choices.length === 0) {
      this.#logRaw("MakeSingleChoice did not contain a usable prompt and choices", raw);
      return;
    }
    this.#handledChoices.add(token);

    const round = this.#observeRound(inferRound(state, "MakeSingleChoice", this.#round));
    const deadlineMs = computeDeadlineMs(
      state,
      this.#now(),
      this.#options.defaultVoteTimeoutMs,
      this.#options.timerSafetyMs,
    );
    const playerId = this.#requirePlayerId();
    const options = choices.map((choice) => choice.label);
    this.#emitEvent({
      type: "vote.requested",
      gameId: this.gameId,
      round,
      playerId,
      prompt,
      options,
      deadlineMs,
      at: this.#at(),
    });

    const result = await this.#beforeDeadline(
      () => this.player.vote(prompt, options, this.#context(round, prompt, deadlineMs)),
      deadlineMs,
      0,
    );
    const selectedIndex = Number.isInteger(result.value) && result.value >= 0 && result.value < choices.length
      ? result.value
      : 0;
    const selected = choices[selectedIndex] ?? choices[0];
    if (!selected) return;
    try {
      // UNVERIFIED: player choose send is from docs/ecast-protocol.md §4.
      await this.connection.sendToHost({ action: "choose", choice: selected.runtimeId });
      this.#emitEvent({
        type: "vote.cast",
        gameId: this.gameId,
        round,
        playerId,
        prompt,
        choice: selectedIndex,
        at: this.#at(),
      });
    } catch (error) {
      this.#handledChoices.delete(token);
      this.#logRaw("Vote submission failed", raw, error);
      this.#reportError(asError(error));
    }
  }

  async #postGame(raw: StateView): Promise<void> {
    const action = this.#options.postGameAction;
    if (action === "none" || !this.isVip || this.#postGameAttempted) return;
    this.#postGameAttempted = true;
    try {
      // UNVERIFIED: post-game sends are from docs/ecast-protocol.md §4.
      await this.connection.sendToHost({
        action: action === "newPlayers" ? "PostGame_NewGame" : "PostGame_Continue",
      });
    } catch (error) {
      this.#logRaw("Post-game VIP action failed", raw, error);
      this.#reportError(asError(error));
    }
  }

  #observeRound(round: RoundNumber): RoundNumber {
    if (this.#round === round) return round;
    this.#round = round;
    this.#emitEvent({ type: "round.started", gameId: this.gameId, round, at: this.#at() });
    return round;
  }

  #context(round: RoundNumber, prompt: string, deadlineMs: number): PlayerContext {
    return {
      gameId: this.gameId,
      round,
      deadlineMs,
      onThinking: (text) => this.#emitEvent({
        type: "thinking.delta",
        gameId: this.gameId,
        playerId: this.#requirePlayerId(),
        text,
        at: this.#at(),
      }),
      onDraft: (text) => this.#emitEvent({
        type: "answer.draft",
        gameId: this.gameId,
        playerId: this.#requirePlayerId(),
        text,
        at: this.#at(),
      }),
    };
  }

  async #beforeDeadline<T>(work: () => Promise<T>, deadlineMs: number, fallback: T): Promise<DeadlineResult<T>> {
    const startedAt = this.#now();
    const remainingMs = Math.max(0, deadlineMs - startedAt);
    let timer: NodeJS.Timeout | undefined;
    const workResult = Promise.resolve().then(work).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: asError(error) }),
    );
    const timeoutResult = new Promise<{ timeout: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), remainingMs);
    });
    const result = await Promise.race([workResult, timeoutResult]);
    if (timer) clearTimeout(timer);
    const latencyMs = Math.max(0, this.#now() - startedAt);
    if ("timeout" in result) return { value: fallback, latencyMs, fallback: true };
    if (!result.ok) {
      this.#reportError(result.error);
      return { value: fallback, latencyMs, fallback: true };
    }
    return { value: result.value, latencyMs, fallback: false };
  }

  #view(): StateView {
    const roomEntity = this.connection.entities.get("room");
    const playerEntity = this.connection.welcome
      ? this.connection.entities.get(`player:${this.connection.welcome.id}`)
      : undefined;
    const room = recordValue(roomEntity?.value);
    const player = recordValue(playerEntity?.value);
    return {
      room,
      player,
      merged: { ...room, ...player },
      ...(roomEntity ? { roomEntity } : {}),
      ...(playerEntity ? { playerEntity } : {}),
    };
  }

  #requirePlayerId(): string {
    const id = this.playerId;
    if (!id) throw new Error("Quiplash seat has no player id before welcome");
    return id;
  }

  #emitEvent(event: AnyEvent): void {
    this.emit("event", event);
    try {
      this.#options.onEvent?.(event);
    } catch (error) {
      this.#logRaw("Quiplash event callback threw", event, error);
    }
  }

  #reportError(error: Error): void {
    const event: GameEvent = {
      type: "harness.error",
      gameId: this.gameId,
      ...(this.playerId ? { playerId: this.playerId } : {}),
      message: error.message,
      at: this.#at(),
    };
    this.#emitEvent(event);
  }

  #logRaw(message: string, raw?: unknown, error?: unknown): void {
    const details = error ? `${message}: ${asError(error).message}` : message;
    if (this.#options.log) {
      this.#options.log(details, raw);
      return;
    }
    console.warn(`[quiparena/jackbox] ${details}`, raw === undefined ? "" : raw);
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }
}

interface StateView {
  room: Record<string, unknown>;
  player: Record<string, unknown>;
  merged: Record<string, unknown>;
  roomEntity?: EntityRecord;
  playerEntity?: EntityRecord;
}

function isStartable(state: Record<string, unknown>): boolean {
  return state.state === "Lobby"
    && state.playerIsVIP === true
    && state.gameCanStart === true
    && state.playerCanStartGame === true
    && state.gameIsStarting !== true
    && state.gameFinished !== true;
}

function entryToken(state: Record<string, unknown>, entity?: EntityRecord): string {
  const entryId = primitiveToken(state.entryId);
  return entryId ?? JSON.stringify([
    state.state,
    state.textKey,
    extractPrompt(state.prompt),
    entity?.key,
  ]);
}

function choiceToken(
  state: Record<string, unknown>,
  entity: EntityRecord | undefined,
  choices: readonly ChoiceProjection[],
): string {
  const choiceId = primitiveToken(state.choiceId);
  return choiceId ?? JSON.stringify([
    state.state,
    extractPrompt(state.prompt),
    choices.map((choice) => [choice.label, choice.runtimeId]),
    entity?.key,
  ]);
}

function primitiveToken(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function projectChoices(value: unknown): ChoiceProjection[] {
  if (!Array.isArray(value)) return [];
  const choices: ChoiceProjection[] = [];
  value.forEach((candidate, position) => {
    if (typeof candidate === "string") {
      choices.push({ label: extractText(candidate), runtimeId: position });
      return;
    }
    const choice = asRecord(candidate);
    if (!choice || choice.disabled === true) return;
    const label = extractText(choice.html ?? choice.text ?? choice.label ?? choice.value);
    if (!label) return;
    choices.push({
      label,
      runtimeId: choice.index ?? choice.key ?? position,
    });
  });
  return choices;
}

function inferRound(
  state: Record<string, unknown>,
  layout: "EnterSingleText" | "MakeSingleChoice",
  current?: RoundNumber,
  normalAnswerCount = 0,
): RoundNumber {
  // UNVERIFIED: docs/ecast-protocol.md §4 says exact round-number fields are unknown.
  for (const candidate of [state.round, state.roundNumber, state.currentRound]) {
    const value = typeof candidate === "string" ? Number(candidate) : candidate;
    if (value === 1 || value === 2 || value === 3) return value;
  }
  if (layout === "MakeSingleChoice" && current === 3) return 3;
  if (layout === "EnterSingleText") return normalAnswerCount > 2 ? 2 : 1;
  return current === 1 || current === 2 ? current : 1;
}

function computeDeadlineMs(
  state: Record<string, unknown>,
  now: number,
  fallbackDurationMs: number,
  safetyMs: number,
): number {
  // UNVERIFIED: no timer field shape was captured; docs/ecast-protocol.md §7 only
  // establishes that the real game timer is authoritative. Accept common additive
  // variants and fall back to the configured answer/vote budget.
  const timer = asRecord(state.timer);
  const absolute = firstNumber(
    state.deadlineMs,
    state.deadline,
    state.timerEndsAt,
    state.timerEnd,
    state.endTime,
    timer?.deadlineMs,
    timer?.endTime,
  );
  let rawDeadline: number | undefined;
  if (absolute !== undefined) {
    rawDeadline = absolute > 1_000_000_000_000
      ? absolute
      : absolute > 1_000_000_000
        ? absolute * 1_000
        : undefined;
  }

  if (rawDeadline === undefined) {
    const relativeMs = firstNumber(state.timeLeftMs, state.timeRemainingMs, timer?.remainingMs);
    const relativeSeconds = firstNumber(
      state.timeLeft,
      state.timeRemaining,
      state.secondsRemaining,
      timer?.remaining,
      timer?.timeLeft,
      typeof state.timer === "number" ? state.timer : undefined,
    );
    if (relativeMs !== undefined) rawDeadline = now + Math.max(0, relativeMs);
    else if (relativeSeconds !== undefined) {
      rawDeadline = now + Math.max(0, relativeSeconds > 600 ? relativeSeconds : relativeSeconds * 1_000);
    } else {
      const duration = firstNumber(timer?.durationMs, timer?.duration);
      const elapsed = firstNumber(timer?.elapsedMs, timer?.elapsed) ?? 0;
      if (duration !== undefined) {
        const remaining = Math.max(0, duration - elapsed);
        rawDeadline = now + (timer?.durationMs !== undefined || remaining > 600 ? remaining : remaining * 1_000);
      }
    }
  }

  return Math.max(now, (rawDeadline ?? now + fallbackDurationMs) - Math.max(0, safetyMs));
}

function extractPrompt(value: unknown): string {
  let html: string | undefined;
  if (typeof value === "string") html = value;
  else {
    const object = asRecord(value);
    const candidate = object?.html ?? object?.text ?? object?.value;
    if (typeof candidate === "string") html = candidate;
  }
  if (!html) return "";
  const withoutHeader = html.replace(
    /<[^>]*class=["'][^"']*header[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/i,
    " ",
  );
  return extractText(withoutHeader).replace(/^Prompt\s+\d+\s+of\s+\d+\s*/i, "").trim();
}

function extractText(value: unknown): string {
  if (typeof value !== "string") return "";
  return decodeHtml(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
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

function cleanLine(value: unknown, maxLength?: number): string {
  const normalized = String(value ?? "")
    .normalize("NFC")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!maxLength || maxLength < 1) return normalized;
  return [...normalized].slice(0, Math.floor(maxLength)).join("");
}

function variantAnswers(
  answers: [string, string, string],
  attempt: number,
  maxLength?: number,
): [string, string, string] {
  return answers.map((answer, index) => {
    const marker = "!".repeat(attempt + index);
    const suffix = `${answer ? " " : ""}${marker}`;
    const room = maxLength ? Math.max(0, Math.floor(maxLength) - [...suffix].length) : undefined;
    const base = room === undefined ? answer : [...answer].slice(0, room).join("");
    return cleanLine(`${base}${suffix}`, maxLength);
  }) as [string, string, string];
}

function isDuplicateAnswerError(error: unknown): boolean {
  if (!(error instanceof EcastProtocolError) && !(error instanceof Error)) return false;
  return /same\s+answer|duplicate|identical|already\s+(?:used|answered)/i.test(error.message);
}

function parseScores(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const scores: Record<string, number> = {};
  for (const [key, score] of Object.entries(record)) {
    if (typeof score === "number" && Number.isFinite(score)) scores[key] = score;
  }
  return Object.keys(scores).length > 0 ? scores : undefined;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
