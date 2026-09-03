import type {
  Answer,
  GameEvent,
  Matchup,
  RoundNumber,
  ThriplashEntry,
  Vote,
} from "@quiparena/core";
import type { Player, PlayerContext, SeatCredentials } from "@quiparena/jackbox";

import type { CreateSeatOptions, GameClient, Seat, SeatWelcome, WorkerRoom } from "./seat.js";

export interface FakeHarnessOptions {
  playerCount?: number;
  paceMs?: number;
  actionTimeoutMs?: number;
  now?: () => number;
}

interface ActionResult<T> {
  value: T;
  blank: boolean;
  latencyMs: number;
}

class FakeGame {
  readonly seats: FakeSeat[] = [];
  readonly expectedPlayers: number;
  readonly paceMs: number;
  readonly actionTimeoutMs: number;
  readonly now: () => number;
  #started = false;
  #created = false;
  #connectedWaiters = new Set<() => void>();

  constructor(readonly gameId: string, readonly roomCode: string, options: Required<FakeHarnessOptions>) {
    this.expectedPlayers = options.playerCount;
    this.paceMs = options.paceMs;
    this.actionTimeoutMs = options.actionTimeoutMs;
    this.now = options.now;
  }

  addSeat(options: CreateSeatOptions): FakeSeat {
    const seat = new FakeSeat(this, options, this.seats.length);
    this.seats.push(seat);
    return seat;
  }

  connect(seat: FakeSeat): SeatWelcome {
    seat.connected = true;
    if (!this.#created) {
      this.#created = true;
      this.emit({ type: "game.created", gameId: this.gameId, roomCode: this.roomCode, at: this.at() });
    }
    seat.emit({
      type: "player.joined",
      gameId: this.gameId,
      player: { id: seat.playerId, name: seat.player.name, modelId: seat.player.modelId },
      at: this.at(),
    });
    if (this.connectedCount >= this.expectedPlayers) {
      for (const resolve of this.#connectedWaiters) resolve();
      this.#connectedWaiters.clear();
    }
    return { id: seat.numericId, name: seat.player.name };
  }

  get connectedCount(): number {
    return this.seats.filter((seat) => seat.connected).length;
  }

  async waitUntilCanStart(timeoutMs = 30_000): Promise<void> {
    if (this.connectedCount >= this.expectedPlayers) return;
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#connectedWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#connectedWaiters.delete(done);
        reject(new Error(`Fake lobby received ${this.connectedCount}/${this.expectedPlayers} players`));
      }, timeoutMs);
      this.#connectedWaiters.add(done);
    });
  }

  start(seat: FakeSeat): boolean {
    if (seat !== this.seats[0] || this.#started || this.connectedCount < this.expectedPlayers) return false;
    this.#started = true;
    void this.drive().catch((error: unknown) => {
      seat.emit({
        type: "harness.error",
        gameId: this.gameId,
        message: error instanceof Error ? error.message : String(error),
        at: this.at(),
      });
      this.finish({});
    });
    return true;
  }

  private async drive(): Promise<void> {
    const active = this.seats.filter((seat) => seat.connected);
    const scores = Object.fromEntries(active.map((seat) => [seat.playerId, 0])) as Record<string, number>;
    this.emit({ type: "game.started", gameId: this.gameId, at: this.at() });
    await this.pause();

    for (const round of [1, 2] as const) {
      this.emit({ type: "round.started", gameId: this.gameId, round, at: this.at() });
      const multiplier = round;
      for (let index = 0; index < active.length; index += 1) {
        const left = active[index]!;
        const right = active[(index + 1) % active.length]!;
        const prompt = round === 1
          ? `The worst slogan for fake product ${index + 1}`
          : `A rejected title for fake sequel ${index + 1}`;
        const leftAnswer = await this.answer(left, prompt, round);
        const rightAnswer = await this.answer(right, prompt, round);
        const answers: [Answer, Answer] = [
          { playerId: left.playerId, text: leftAnswer.value, blank: leftAnswer.blank },
          { playerId: right.playerId, text: rightAnswer.value, blank: rightAnswer.blank },
        ];
        const gameVotes: Vote[] = [];
        for (const voter of active.filter((candidate) => candidate !== left && candidate !== right)) {
          const choice = await this.vote(voter, prompt, answers.map((answer) => answer.text), round);
          gameVotes.push({ voterId: voter.playerId, population: "player", choice });
        }
        const leftPoints = gameVotes.filter((vote) => vote.choice === 0).length * 100 * multiplier;
        const rightPoints = gameVotes.filter((vote) => vote.choice === 1).length * 100 * multiplier;
        scores[left.playerId] = (scores[left.playerId] ?? 0) + leftPoints;
        scores[right.playerId] = (scores[right.playerId] ?? 0) + rightPoints;
        const matchup: Matchup = {
          id: `${this.gameId}:r${round}:m${index}`,
          gameId: this.gameId,
          round,
          index,
          prompt,
          answers,
          votes: gameVotes,
          scores: { [left.playerId]: leftPoints, [right.playerId]: rightPoints },
        };
        this.emit({ type: "matchup.resolved", gameId: this.gameId, matchup, at: this.at() });
        await this.pause();
      }
    }

    this.emit({ type: "round.started", gameId: this.gameId, round: 3, at: this.at() });
    const finalPrompt = "Three warning signs your fake harness is haunted";
    const entries: ThriplashEntry[] = [];
    for (const seat of active) {
      const result = await this.finalAnswer(seat, finalPrompt);
      entries.push({ playerId: seat.playerId, lines: result.value });
    }
    const finalVotes: Vote[] = [];
    for (const voter of active) {
      const eligible = entries.filter((entry) => entry.playerId !== voter.playerId);
      const localChoice = await this.vote(
        voter,
        finalPrompt,
        eligible.map((entry) => entry.lines.join(" / ")),
        3,
      );
      const selected = eligible[localChoice] ?? eligible[0];
      const choice = Math.max(0, entries.findIndex((entry) => entry === selected));
      finalVotes.push({ voterId: voter.playerId, population: "player", choice });
    }
    const finalRoundScores: Record<string, number> = {};
    entries.forEach((entry, index) => {
      const points = finalVotes.filter((vote) => vote.choice === index).length * 300;
      finalRoundScores[entry.playerId] = points;
      scores[entry.playerId] = (scores[entry.playerId] ?? 0) + points;
    });
    this.emit({
      type: "thriplash.resolved",
      gameId: this.gameId,
      thriplash: {
        gameId: this.gameId,
        prompt: finalPrompt,
        entries,
        votes: finalVotes,
        scores: finalRoundScores,
      },
      at: this.at(),
    });
    await this.pause();
    this.finish(scores);
  }

  private async answer(seat: FakeSeat, prompt: string, round: 1 | 2): Promise<ActionResult<string>> {
    const deadlineMs = this.now() + this.actionTimeoutMs;
    seat.emit({
      type: "prompt.dealt",
      gameId: this.gameId,
      round,
      playerId: seat.playerId,
      prompt,
      deadlineMs,
      at: this.at(),
    });
    const result = await this.action(seat, () => seat.player.answer(prompt, this.context(seat, prompt, round, deadlineMs)), "");
    seat.emit({
      type: "answer.submitted",
      gameId: this.gameId,
      round,
      playerId: seat.playerId,
      prompt,
      answer: result.value,
      blank: result.blank || result.value.trim().length === 0,
      latencyMs: result.latencyMs,
      at: this.at(),
    });
    return result;
  }

  private async finalAnswer(seat: FakeSeat, prompt: string): Promise<ActionResult<[string, string, string]>> {
    const deadlineMs = this.now() + this.actionTimeoutMs;
    seat.emit({
      type: "prompt.dealt",
      gameId: this.gameId,
      round: 3,
      playerId: seat.playerId,
      prompt,
      deadlineMs,
      at: this.at(),
    });
    const result = await this.action(
      seat,
      () => seat.player.answerFinal(prompt, this.context(seat, prompt, 3, deadlineMs)),
      ["", "", ""] as [string, string, string],
    );
    seat.emit({
      type: "answer.submitted",
      gameId: this.gameId,
      round: 3,
      playerId: seat.playerId,
      prompt,
      answer: result.value,
      blank: result.blank || result.value.every((line) => line.trim().length === 0),
      latencyMs: result.latencyMs,
      at: this.at(),
    });
    return result;
  }

  private async vote(
    seat: FakeSeat,
    prompt: string,
    options: string[],
    round: RoundNumber,
  ): Promise<number> {
    const deadlineMs = this.now() + this.actionTimeoutMs;
    seat.emit({
      type: "vote.requested",
      gameId: this.gameId,
      round,
      playerId: seat.playerId,
      prompt,
      options,
      deadlineMs,
      at: this.at(),
    });
    const result = await this.action(
      seat,
      () => seat.player.vote(prompt, options, this.context(seat, prompt, round, deadlineMs)),
      0,
    );
    const choice = Number.isInteger(result.value) && result.value >= 0 && result.value < options.length
      ? result.value
      : 0;
    seat.emit({
      type: "vote.cast",
      gameId: this.gameId,
      round,
      playerId: seat.playerId,
      prompt,
      choice,
      at: this.at(),
    });
    return choice;
  }

  private context(seat: FakeSeat, _prompt: string, round: RoundNumber, deadlineMs: number): PlayerContext {
    return {
      gameId: this.gameId,
      round,
      deadlineMs,
      maxLength: 45,
      ...(round === 3 ? { fieldCount: 3 } : {}),
      onThinking: (text) => seat.emit({
        type: "thinking.delta",
        gameId: this.gameId,
        playerId: seat.playerId,
        text,
        at: this.at(),
      }),
      onDraft: (text) => seat.emit({
        type: "answer.draft",
        gameId: this.gameId,
        playerId: seat.playerId,
        text,
        at: this.at(),
      }),
    };
  }

  private async action<T>(seat: FakeSeat, work: () => Promise<T>, fallback: T): Promise<ActionResult<T>> {
    const startedAt = this.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ ok: false; timeout: true }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, timeout: true }), this.actionTimeoutMs);
    });
    const result = await Promise.race([
      Promise.resolve().then(work).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    if (!result.ok) {
      const message = "timeout" in result
        ? `${seat.player.name} timed out`
        : result.error instanceof Error ? result.error.message : String(result.error);
      seat.emit({
        type: "harness.error",
        gameId: this.gameId,
        playerId: seat.playerId,
        message,
        at: this.at(),
      });
      return { value: fallback, blank: true, latencyMs: Math.max(0, this.now() - startedAt) };
    }
    return { value: result.value, blank: false, latencyMs: Math.max(0, this.now() - startedAt) };
  }

  private finish(scores: Record<string, number>): void {
    this.emit({ type: "game.ended", gameId: this.gameId, finalScores: scores, at: this.at() });
    for (const seat of this.seats) seat.end();
  }

  private emit(event: GameEvent): void {
    this.seats.find((seat) => seat.connected)?.emit(event);
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  private async pause(): Promise<void> {
    if (this.paceMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.paceMs));
  }
}

class FakeSeat implements Seat {
  readonly player: Player;
  readonly gameId: string;
  readonly playerId: string;
  readonly numericId: number;
  readonly credentials: SeatCredentials;
  connected = false;
  #resolveEnded!: () => void;
  readonly #ended: Promise<void>;

  constructor(readonly game: FakeGame, readonly options: CreateSeatOptions, index: number) {
    this.player = options.player;
    this.gameId = options.gameId;
    this.numericId = index + 2;
    this.playerId = String(this.numericId);
    this.credentials = {
      room: game.roomCode,
      name: options.player.name,
      userId: `fake-user-${this.numericId}`,
      deviceId: `fake-device-${this.numericId}`,
      id: this.numericId,
      secret: `fake-secret-${this.numericId}`,
    };
    this.#ended = new Promise<void>((resolve) => {
      this.#resolveEnded = resolve;
    });
  }

  async connect(): Promise<SeatWelcome> {
    return this.game.connect(this);
  }

  async close(): Promise<void> {}

  waitForGameEnd(): Promise<void> {
    return this.#ended;
  }

  async waitUntilCanStart(timeoutMs?: number): Promise<void> {
    await this.game.waitUntilCanStart(timeoutMs);
  }

  async waitUntilAvatarSelected(): Promise<void> {}

  async startIfVip(): Promise<boolean> {
    return this.game.start(this);
  }

  emit(event: GameEvent | Parameters<CreateSeatOptions["onEvent"]>[0]): void {
    this.options.onEvent(event);
  }

  end(): void {
    this.#resolveEnded();
  }
}

/** In-process GameClient that produces the same domain event stream as the real harness. */
export class FakeHarness implements GameClient {
  readonly eventsAreAggregated = true;
  readonly #options: Required<FakeHarnessOptions>;
  readonly #games = new Map<string, FakeGame>();

  constructor(options: FakeHarnessOptions = {}) {
    this.#options = {
      playerCount: options.playerCount ?? 8,
      paceMs: options.paceMs ?? 0,
      actionTimeoutMs: options.actionTimeoutMs ?? 1_000,
      now: options.now ?? Date.now,
    };
  }

  async lookupRoom(roomCode: string): Promise<WorkerRoom> {
    return { code: roomCode.toUpperCase(), maxPlayers: this.#options.playerCount };
  }

  createSeat(options: CreateSeatOptions): Seat {
    let game = this.#games.get(options.gameId);
    if (!game) {
      game = new FakeGame(options.gameId, options.room.code, this.#options);
      this.#games.set(options.gameId, game);
    }
    return game.addSeat(options);
  }
}
