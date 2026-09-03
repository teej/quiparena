import { EventEmitter } from "node:events";

import type { AnyEvent, GameEvent, RoundNumber } from "@quiparena/core";

import { EcastConnection, EcastProtocolError, type EcastWelcome, type EntityRecord } from "./ecast.js";
import type { Player, PlayerContext } from "./player.js";

export type PostGameAction = "newPlayers" | "samePlayers" | "none";

export interface Quiplash3SeatOptions {
  gameId: string;
  defaultAnswerTimeoutMs?: number;
  defaultThriplashTimeoutMs?: number;
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
  timedOut: boolean;
}

interface StateTiming {
  token: string;
  state: string;
  enteredAt: number;
}

interface ActiveOccurrence {
  token: string;
  handled: boolean;
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
  #startCountdownObserved = false;
  #postGameAttempted = false;
  #cancelAttempted = false;
  #normalAnswerCount = 0;
  #round?: RoundNumber;
  #entryOccurrence: ActiveOccurrence | undefined;
  #choiceOccurrence: ActiveOccurrence | undefined;
  #loggedNoopStates = new Set<string>();
  #stateTiming?: StateTiming;
  #resolveEnded!: () => void;
  readonly #endedPromise: Promise<void>;
  readonly #options: Required<Pick<Quiplash3SeatOptions,
    "defaultAnswerTimeoutMs" | "defaultThriplashTimeoutMs" | "defaultVoteTimeoutMs" | "timerSafetyMs" | "autoStart" | "postGameAction">>
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
      defaultThriplashTimeoutMs: options.defaultThriplashTimeoutMs ?? 60_000,
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
      this.#observeStateTiming();
      void this.#enqueueState();
    });
    connection.on("entity", () => {
      this.#observeStateTiming();
      void this.#enqueueState();
    });
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

  get canCancelStart(): boolean {
    return isCancelStartable(this.#view().merged);
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

  /** Wait until all state updates observed so far have finished processing. */
  waitForIdle(): Promise<void> {
    return this.#actions;
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

  /** Send the controller's VIP start-countdown cancellation action when offered. */
  async cancelStartIfVip(): Promise<boolean> {
    let cancelled = false;
    await this.#enqueue(async () => {
      const raw = this.#view();
      if (!isCancelStartable(raw.merged) || this.#cancelAttempted) return;
      this.#cancelAttempted = true;
      try {
        await this.connection.sendToHost({ action: "cancel" });
        cancelled = true;
      } catch (error) {
        this.#cancelAttempted = false;
        this.#logRaw("VIP start cancellation was rejected", raw, error);
        throw error;
      }
    });
    return cancelled;
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

    // entryId and choiceId are layout-local cursor values, not globally unique
    // state identifiers. The host reuses them across rounds and matchups, so an
    // occurrence ends when its layout does (and can also advance in-place when
    // its prompt/cursor changes).
    if (state !== "EnterSingleText" && state !== "EnterTextList") {
      this.#entryOccurrence = undefined;
    }
    if (state !== "MakeSingleChoice") this.#choiceOccurrence = undefined;

    if (!this.#started && (raw.merged.gameIsStarting === true || isRoundState(state))) {
      this.#started = true;
      this.#emitEvent({ type: "game.started", gameId: this.gameId, at: this.#at() });
    }

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
      case "Logo":
        break;
      case "UGC":
      case "Draw":
      case "Shoot":
      case "Sortable":
      case "Camera":
        this.#logNoopState(state, raw);
        break;
      default:
        if (state) this.#logNoopState(state, raw);
        break;
    }
  }

  async #handleLobby(raw: StateView): Promise<void> {
    const state = raw.merged;
    if (state.gameFinished === true) {
      if (!this.#ended) {
        this.#ended = true;
        // Player controllers do not expose results. This VIP-only event is a
        // post-game signal consumed and reconstructed by GameAggregator.
        if (this.isVip) this.#emitEvent({ type: "game.ended", gameId: this.gameId, at: this.#at() });
      }
      try {
        await this.#postGame(raw);
      } finally {
        this.#resolveEnded();
      }
      return;
    }

    if (state.gameIsStarting === true) this.#startCountdownObserved = true;
    else if (this.#startCountdownObserved) {
      this.#startAttempted = false;
      this.#cancelAttempted = false;
      this.#startCountdownObserved = false;
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
      await this.connection.sendToHost({ action: "start" });
    } catch (error) {
      this.#startAttempted = false;
      this.#logRaw("VIP start was rejected", raw, error);
      throw error;
    }
  }

  async #handleSingleAnswer(raw: StateView): Promise<void> {
    const state = raw.merged;
    // The official layout keeps the form open for every falsy entry. doneText
    // is presentation only and is deliberately not a completion signal.
    if (Boolean(state.entry)) {
      this.#entryOccurrence = undefined;
      return;
    }
    const prompt = extractPrompt(state.prompt);
    const token = entryToken(state, raw.playerEntity);
    if (this.#entryOccurrence?.token !== token) {
      this.#entryOccurrence = { token, handled: false };
    }
    if (this.#entryOccurrence.handled) return;
    if (!prompt) {
      this.#logRaw("EnterSingleText did not contain a usable prompt", raw);
      return;
    }
    this.#entryOccurrence.handled = true;
    this.#normalAnswerCount += 1;

    const round = this.#observeRound(inferRound(
      state,
      "EnterSingleText",
      this.#round,
      this.#normalAnswerCount,
    ));
    const timeoutMs = this.#options.defaultAnswerTimeoutMs;
    const deadlineMs = deadlineAt(this.#now(), timeoutMs, this.#options.timerSafetyMs);
    const playerId = this.#requirePlayerId();
    this.#emitEvent({
      type: "prompt.dealt",
      gameId: this.gameId,
      round,
      playerId,
      prompt,
      deadlineMs: timeoutMs,
      controller: controllerRaw(state),
      at: this.#at(),
    });

    const result = await this.#beforeDeadline(
      () => this.player.answer(prompt, this.#context(round, prompt, deadlineMs)),
      deadlineMs,
      "",
    );
    const maxLength = positiveInteger(state.maxLength) ?? 45;
    const answer = cleanLine(result.value, maxLength);
    try {
      const submittedAnswer = await this.#submitSingleAnswer(
        state,
        answer,
        raw,
        deadlineMs,
        result.timedOut && offersSafetyQuip(state.actions),
      );
      this.#emitEvent({
        type: "answer.submitted",
        gameId: this.gameId,
        round,
        playerId,
        prompt,
        answer: submittedAnswer,
        blank: result.fallback || submittedAnswer.trim().length === 0 || submittedAnswer === "⁇",
        latencyMs: result.latencyMs,
        controller: controllerRaw(state),
        at: this.#at(),
      });
    } catch (error) {
      this.#logRaw("Single-answer submission failed", raw, error);
      this.#reportError(asError(error));
    }
  }

  async #submitSingleAnswer(
    state: Record<string, unknown>,
    initialAnswer: string,
    raw: StateView,
    deadlineMs: number,
    useSafetyQuip: boolean,
  ): Promise<string> {
    const textKey = typeof state.textKey === "string" && state.textKey ? state.textKey : undefined;
    if (useSafetyQuip) {
      if (textKey) await this.connection.request("text/update", { key: textKey, val: "⁇" });
      else await this.connection.sendToHost({ action: "safetyQuip" });
      return "⁇";
    }

    const maxLength = positiveInteger(state.maxLength) ?? 45;
    let answer = initialAnswer;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (textKey) await this.connection.request("text/update", { key: textKey, val: answer });
        else {
          this.#logRaw("EnterSingleText has no textKey; using the controller host fallback", raw);
          await this.connection.sendToHost({ action: "write", entry: answer || " " });
        }
        return answer;
      } catch (error) {
        if (!isDuplicateAnswerError(error) || attempt === 2 || this.#now() >= deadlineMs) throw error;
        answer = variantAnswer(answer, attempt + 1, maxLength);
      }
    }
    return answer;
  }

  async #handleThriplash(raw: StateView): Promise<void> {
    const state = raw.merged;
    if (Boolean(state.entries)) {
      this.#entryOccurrence = undefined;
      return;
    }
    const prompt = extractPrompt(state.prompt);
    const token = entryToken(state, raw.playerEntity);
    if (this.#entryOccurrence?.token !== token) {
      this.#entryOccurrence = { token, handled: false };
    }
    if (this.#entryOccurrence.handled) return;
    if (!prompt) {
      this.#logRaw("EnterTextList did not contain a usable prompt", raw);
      return;
    }
    this.#entryOccurrence.handled = true;

    const round = this.#observeRound(3);
    const timeoutMs = this.#options.defaultThriplashTimeoutMs;
    const deadlineMs = deadlineAt(this.#now(), timeoutMs, this.#options.timerSafetyMs);
    const playerId = this.#requirePlayerId();
    this.#emitEvent({
      type: "prompt.dealt",
      gameId: this.gameId,
      round,
      playerId,
      prompt,
      deadlineMs: timeoutMs,
      controller: controllerRaw(state),
      at: this.#at(),
    });

    const result = await this.#beforeDeadline(
      () => this.player.answerFinal(prompt, this.#context(round, prompt, deadlineMs)),
      deadlineMs,
      ["", "", ""] as [string, string, string],
    );
    const maxLength = positiveInteger(state.maxLength) ?? 45;
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
        controller: controllerRaw(state),
        at: this.#at(),
      });
    } catch (error) {
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
    const fieldCount = positiveInteger(state.fieldCount) ?? 3;
    let answers = initialAnswers;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fields = [...answers].slice(0, fieldCount);
      while (fields.length < fieldCount) fields.push("");
      try {
        if (typeof state.textKey === "string" && state.textKey) {
          await this.connection.request("text/update", { key: state.textKey, val: fields.join("\n") });
        } else {
          this.#logRaw("EnterTextList has no textKey; using the controller host fallback", raw);
          await this.connection.sendToHost({ action: "write", entries: fields });
        }
        return answers;
      } catch (error) {
        if (!isDuplicateAnswerError(error) || attempt === 2 || this.#now() >= deadlineMs) throw error;
        answers = variantAnswers(answers, attempt + 1, positiveInteger(state.maxLength) ?? 45);
      }
    }
    return answers;
  }

  async #handleVote(raw: StateView): Promise<void> {
    const state = raw.merged;
    // The controller shows choices for null and the empty string. Treat missing
    // data like its null model default; doneText alone never completes a vote.
    if (state.chosen !== null && state.chosen !== undefined && state.chosen !== "") {
      this.#choiceOccurrence = undefined;
      return;
    }
    const prompt = extractPrompt(state.prompt);
    const choices = projectChoices(state.choices);
    const token = choiceToken(state, raw.playerEntity, choices);
    if (this.#choiceOccurrence?.token !== token) {
      this.#choiceOccurrence = { token, handled: false };
    }
    if (this.#choiceOccurrence.handled) return;
    if (!prompt || choices.length === 0) {
      this.#logRaw("MakeSingleChoice did not contain a usable prompt and choices", raw);
      return;
    }
    this.#choiceOccurrence.handled = true;

    const round = this.#observeRound(inferRound(state, "MakeSingleChoice", this.#round));
    const timeoutMs = this.#options.defaultVoteTimeoutMs;
    const deadlineMs = deadlineAt(this.#now(), timeoutMs, this.#options.timerSafetyMs);
    const playerId = this.#requirePlayerId();
    const options = choices.map((choice) => choice.label);
    this.#emitEvent({
      type: "vote.requested",
      gameId: this.gameId,
      round,
      playerId,
      prompt,
      options,
      deadlineMs: timeoutMs,
      controller: controllerRaw(state),
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
      await this.connection.sendToHost({ action: "choose", choice: selected.runtimeId });
      this.#emitEvent({
        type: "vote.cast",
        gameId: this.gameId,
        round,
        playerId,
        prompt,
        choice: selectedIndex,
        ...(typeof selected.runtimeId === "string" || typeof selected.runtimeId === "number"
          ? { choiceKey: selected.runtimeId }
          : {}),
        answer: selected.label,
        controller: controllerRaw(state),
        at: this.#at(),
      });
    } catch (error) {
      this.#logRaw("Vote submission failed", raw, error);
      this.#reportError(asError(error));
    }
  }

  async #postGame(raw: StateView): Promise<void> {
    const action = this.#options.postGameAction;
    if (action === "none" || !this.isVip || this.#postGameAttempted) return;
    this.#postGameAttempted = true;
    try {
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
    if ("timeout" in result) return { value: fallback, latencyMs, fallback: true, timedOut: true };
    if (!result.ok) {
      this.#reportError(result.error);
      return { value: fallback, latencyMs, fallback: true, timedOut: false };
    }
    return { value: result.value, latencyMs, fallback: false, timedOut: false };
  }

  #view(): StateView {
    const welcome = this.connection.welcome;
    const roomEntity = firstEntity(this.connection, ["room", "roomBlob", "bc:room"]);
    const playerEntity = welcome
      ? firstEntity(this.connection, [`player:${welcome.id}`, "player", `bc:customer:${this.connection.userId}`])
      : undefined;
    const room = recordValue(roomEntity?.value);
    const player = recordValue(playerEntity?.value);
    const { audience: _audience, ...playerRoom } = room;
    return {
      room,
      player,
      merged: { ...playerRoom, ...player, isPlayer: true, isAudience: false },
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

  #logNoopState(state: string, raw: StateView): void {
    const token = stateToken(raw.merged);
    if (this.#loggedNoopStates.has(token)) return;
    this.#loggedNoopStates.add(token);
    this.#logRaw(`${state} is a passive/unsupported controller state; no action taken`, raw);
  }

  #observeStateTiming(): void {
    if (!this.connection.welcome) return;
    const view = this.#view();
    const state = typeof view.merged.state === "string" ? view.merged.state : undefined;
    if (!state) return;
    const token = stateToken(view.merged);
    if (this.#stateTiming?.token === token) return;
    const now = this.#now();
    if (this.#stateTiming) {
      const timing = {
        type: "harness.timing",
        gameId: this.gameId,
        playerId: this.#requirePlayerId(),
        state: this.#stateTiming.state,
        nextState: state,
        durationMs: Math.max(0, now - this.#stateTiming.enteredAt),
        enteredAt: new Date(this.#stateTiming.enteredAt).toISOString(),
        at: new Date(now).toISOString(),
      };
      if (this.#options.log) this.#options.log("harness.timing", timing);
      else console.info(JSON.stringify(timing));
    }
    this.#stateTiming = { token, state, enteredAt: now };
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

function isRoundState(state: string | undefined): boolean {
  return state === "EnterSingleText" || state === "EnterTextList" || state === "MakeSingleChoice";
}

function isCancelStartable(state: Record<string, unknown>): boolean {
  return state.state === "Lobby"
    && state.playerIsVIP === true
    && state.gameIsStarting === true
    && state.gameFinished !== true;
}

function firstEntity(connection: EcastConnection, keys: readonly string[]): EntityRecord | undefined {
  const accepted = new Set(keys);
  const entities = connection.entities.values();
  for (let index = entities.length - 1; index >= 0; index -= 1) {
    const entity = entities[index];
    if (entity && accepted.has(entity.key)) return entity;
  }
  return undefined;
}

function stateToken(state: Record<string, unknown>): string {
  return JSON.stringify([
    state.state,
    primitiveToken(state.entryId),
    primitiveToken(state.choiceId),
    extractPrompt(state.prompt),
    state.gameFinished === true,
    primitiveToken(state.lobbyState),
  ]);
}

function entryToken(state: Record<string, unknown>, entity?: EntityRecord): string {
  return JSON.stringify([
    state.state,
    primitiveToken(state.entryId),
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
  return JSON.stringify([
    state.state,
    primitiveToken(state.choiceId),
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
    if (!choice || choice.disabled === true || choice.visible === false) return;
    const label = extractText(choice.html ?? choice.text ?? choice.label ?? choice.value);
    if (!label) return;
    choices.push({
      label,
      runtimeId: typeof choice.key === "string" || typeof choice.key === "number" ? choice.key : position,
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
  // Round is host-side-only in the official player controller. Honor an extra
  // host field when present, then infer rounds 1/2 from this seat's prompt flow.
  for (const candidate of [state.round, state.roundNumber, state.currentRound]) {
    const value = typeof candidate === "string" ? Number(candidate) : candidate;
    if (value === 1 || value === 2 || value === 3) return value;
  }
  if (layout === "MakeSingleChoice" && current === 3) return 3;
  if (layout === "EnterSingleText") return normalAnswerCount > 2 ? 2 : 1;
  return current === 1 || current === 2 ? current : 1;
}

function deadlineAt(now: number, durationMs: number, safetyMs: number): number {
  return Math.max(now, now + Math.max(0, durationMs) - Math.max(0, safetyMs));
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
  if (typeof value !== "string") {
    const object = asRecord(value);
    return object ? extractText(object.html ?? object.text ?? object.value) : "";
  }
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
  return graphemes(normalized).slice(0, Math.floor(maxLength)).join("");
}

function variantAnswer(answer: string, attempt: number, maxLength: number): string {
  const marker = "!".repeat(attempt);
  const suffix = `${answer ? " " : ""}${marker}`;
  const room = Math.max(0, maxLength - graphemes(suffix).length);
  return cleanLine(`${graphemes(answer).slice(0, room).join("")}${suffix}`, maxLength);
}

function variantAnswers(
  answers: [string, string, string],
  attempt: number,
  maxLength?: number,
): [string, string, string] {
  return answers.map((answer, index) => {
    const marker = "!".repeat(attempt + index);
    const suffix = `${answer ? " " : ""}${marker}`;
    const room = maxLength ? Math.max(0, Math.floor(maxLength) - graphemes(suffix).length) : undefined;
    const base = room === undefined ? answer : graphemes(answer).slice(0, room).join("");
    return cleanLine(`${base}${suffix}`, maxLength);
  }) as [string, string, string];
}

function isDuplicateAnswerError(error: unknown): boolean {
  if (!(error instanceof EcastProtocolError) && !(error instanceof Error)) return false;
  const result = error instanceof EcastProtocolError && error.result !== undefined
    ? safeStringify(error.result)
    : "";
  return /same\s+(?:answer|quip)|duplicate|identical|already\s+(?:used|answered|submitted)/i
    .test(`${error.message} ${result}`);
}

function offersSafetyQuip(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((candidate) => {
    if (candidate === "safetyQuip") return true;
    const action = asRecord(candidate);
    return action?.key === "safetyQuip" || action?.action === "safetyQuip";
  });
}

function controllerRaw(state: Record<string, unknown>): {
  prompt?: unknown;
  choices?: unknown;
  doneText?: unknown;
} {
  return {
    ...(Object.hasOwn(state, "prompt") ? { prompt: state.prompt } : {}),
    ...(Object.hasOwn(state, "choices") ? { choices: state.choices } : {}),
    ...(Object.hasOwn(state, "doneText") ? { doneText: state.doneText } : {}),
  };
}

function graphemes(value: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(value)].map((segment) => segment.segment);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
