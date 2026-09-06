import { EventEmitter } from "node:events";

import type {
  Answer,
  AnyEvent,
  GameEvent,
  Matchup,
  PlayerRef,
  Thriplash,
  ThriplashEntry,
  Vote,
} from "@quiparena/core";

export interface GameAggregatorOptions {
  gameId: string;
  /** Useful when events can arrive before every player.joined event. */
  expectedPlayerCount?: number;
  onEvent?: (event: GameEvent) => void;
}

interface GameAggregatorEventMap {
  event: [event: GameEvent];
}

interface VoteRequest {
  options: string[];
  choiceKeys: Array<string | number>;
}

interface VoteObservation {
  voterId: string;
  prompt: string;
  answerText: string;
  choiceKey?: string | number;
}

interface NormalAccumulator {
  round: 1 | 2;
  index?: number;
  prompt: string;
  answers: Map<string, Answer>;
  requests: Map<string, VoteRequest>;
  votes: Map<string, VoteObservation>;
  emitted: boolean;
  pool: NormalAnswerPool;
}

interface NormalAnswerPool {
  round: 1 | 2;
  prompt: string;
  answers: Map<string, Answer>;
}

interface ThriplashAccumulator {
  prompt: string;
  entries: Map<string, ThriplashEntry>;
  requests: Map<string, VoteRequest>;
  votes: Map<string, VoteObservation>;
  emitted: boolean;
}

/**
 * Reconstructs player-invisible results from the events of every owned seat.
 * It intentionally does not infer scores: the official player controller has
 * no structured scoring/result contract, and the exact host rules are outside
 * the verified source corpus.
 */
export class GameAggregator extends EventEmitter<GameAggregatorEventMap> {
  readonly gameId: string;

  readonly #options: GameAggregatorOptions;
  readonly #players = new Map<string, PlayerRef>();
  readonly #playerOrder: string[] = [];
  readonly #normal = new Map<string, NormalAccumulator>();
  readonly #answerPools = new Map<string, NormalAnswerPool>();
  readonly #normalRequests = new Map<string, NormalAccumulator>();
  readonly #nextMatchupIndex: Record<1 | 2, number> = { 1: 0, 2: 0 };
  #thriplash?: ThriplashAccumulator;
  #created = false;
  #started = false;
  readonly #rounds = new Set<number>();
  #ended = false;

  constructor(options: GameAggregatorOptions) {
    super();
    this.gameId = options.gameId;
    this.#options = options;
  }

  /** Ingest one event from any seat in this game and return events emitted now. */
  ingest(event: AnyEvent): GameEvent[] {
    if (event.gameId !== this.gameId) return [];
    const emitted: GameEvent[] = [];

    switch (event.type) {
      case "game.created":
        if (!this.#created) {
          this.#created = true;
          this.#push(event, emitted);
        }
        break;
      case "player.joined":
        if (!this.#players.has(event.player.id)) this.#playerOrder.push(event.player.id);
        this.#players.set(event.player.id, event.player);
        break;
      case "game.started":
        if (!this.#started) {
          this.#started = true;
          this.#push(event, emitted);
        }
        break;
      case "round.started":
        if (!this.#rounds.has(event.round)) {
          // Skipped voting (e.g. an empty answer) still becomes public when the
          // next round starts. Resolve it before building the next request's history.
          if (event.round > 1) this.#flushResolved(event.at, emitted, true, true);
          this.#rounds.add(event.round);
          this.#push(event, emitted);
        }
        break;
      case "answer.submitted":
        if (event.round === 3 && Array.isArray(event.answer)) {
          const accumulator = this.#thriplashFor(event.prompt);
          accumulator.entries.set(event.playerId, {
            playerId: event.playerId,
            lines: tuple3(event.answer),
            prompt: canonicalPrompt(event.prompt),
          });
        } else if ((event.round === 1 || event.round === 2) && typeof event.answer === "string") {
          const pool = this.#answerPoolFor(event.round, event.prompt);
          pool.answers.set(event.playerId, {
            playerId: event.playerId,
            text: event.answer,
            blank: event.blank,
          });
        }
        break;
      case "vote.requested": {
        const request = voteRequest(event.options, event.controller?.choices);
        if (event.round === 3) {
          this.#thriplashFor(event.prompt).requests.set(
            finalVoteKey(event.prompt, event.playerId),
            request,
          );
        } else {
          const accumulator = this.#normalForVote(event.round, event.prompt, event.options);
          this.#ensureMatchupIndex(accumulator);
          accumulator.requests.set(event.playerId, request);
          this.#normalRequests.set(`${event.round}\u0000${event.playerId}`, accumulator);
        }
        break;
      }
      case "vote.cast": {
        const observation: VoteObservation = {
          voterId: event.playerId,
          prompt: canonicalPrompt(event.prompt),
          answerText: event.answer ?? "",
          ...(event.choiceKey === undefined ? {} : { choiceKey: event.choiceKey }),
        };
        if (event.round === 3) {
          const accumulator = this.#thriplashFor(event.prompt);
          const key = finalVoteKey(event.prompt, event.playerId);
          const request = accumulator.requests.get(key);
          if (!observation.answerText) observation.answerText = selectedAnswer(request, event.choice, event.choiceKey);
          accumulator.votes.set(key, observation);
        } else {
          const accumulator = this.#normalRequests.get(`${event.round}\u0000${event.playerId}`)
            ?? this.#normalForVote(event.round, event.prompt, event.answer ? [event.answer] : []);
          this.#ensureMatchupIndex(accumulator);
          const request = accumulator.requests.get(event.playerId);
          if (!observation.answerText) observation.answerText = selectedAnswer(request, event.choice, event.choiceKey);
          accumulator.votes.set(event.playerId, observation);
        }
        break;
      }
      case "game.ended":
        this.#flushResolved(event.at, emitted, true);
        if (!this.#ended) {
          this.#ended = true;
          this.#push({ type: "game.ended", gameId: this.gameId, at: event.at }, emitted);
        }
        return emitted;
      default:
        break;
    }

    this.#flushResolved(event.at, emitted, false);
    return emitted;
  }

  /** Backward-friendly verb for event pipelines that use add/accept terminology. */
  add(event: AnyEvent): GameEvent[] {
    return this.ingest(event);
  }

  #answerPoolFor(round: 1 | 2, prompt: string): NormalAnswerPool {
    const key = normalKey(round, prompt);
    let pool = this.#answerPools.get(key);
    if (!pool) {
      pool = { round, prompt: canonicalPrompt(prompt), answers: new Map() };
      this.#answerPools.set(key, pool);
    }
    return pool;
  }

  #normalForVote(round: 1 | 2, prompt: string, options: readonly string[]): NormalAccumulator {
    let pool = this.#answerPools.get(normalKey(round, prompt));
    if (!pool && options.length) {
      const candidates = [...this.#answerPools.values()].filter(candidate => candidate.round === round
        && options.some(option => [...candidate.answers.values()].some(answer => normalized(answer.text) === normalized(option))));
      if (candidates.length === 1) pool = candidates[0];
    }
    pool ??= this.#answerPoolFor(round, prompt);
    // A prompt can occur twice in a round. The presented answer pair identifies
    // the matchup; the prompt alone only identifies its pool of submissions.
    const baseKey = JSON.stringify([normalKey(round, pool.prompt), options.map(normalized).sort()]);
    let key = baseKey;
    let accumulator = this.#normal.get(key);
    for (let occurrence = 1; accumulator?.emitted && options.length === 2; occurrence += 1) {
      key = `${baseKey}\u0000${occurrence}`;
      accumulator = this.#normal.get(key);
    }
    if (!accumulator) {
      accumulator = { round, prompt: pool.prompt, pool, answers: new Map(), requests: new Map(), votes: new Map(), emitted: false };
      this.#normal.set(key, accumulator);
    }
    return accumulator;
  }

  #thriplashFor(prompt: string): ThriplashAccumulator {
    if (!this.#thriplash) {
      this.#thriplash = {
        prompt: canonicalPrompt(prompt),
        entries: new Map(),
        requests: new Map(),
        votes: new Map(),
        emitted: false,
      };
    }
    return this.#thriplash;
  }

  #flushResolved(at: string, emitted: GameEvent[], force: boolean, normalOnly = false): void {
    const playerCount = this.#options.expectedPlayerCount ?? this.#players.size;
    for (const accumulator of this.#normal.values()) {
      if (accumulator.emitted) continue;
      const submitted = [...accumulator.pool.answers.values()];
      const eligible = submitted.filter(answer => !accumulator.requests.has(answer.playerId));
      const options = accumulator.requests.values().next().value?.options ?? [];
      const matching = submitted.filter(answer => options.some((option: string) => normalized(option) === normalized(answer.text)));
      const owners = eligible.length === 2 ? eligible : matching.length === 2 ? matching : submitted.length === 2 ? submitted : [];
      accumulator.answers = new Map(owners.map(answer => [answer.playerId, answer]));
    }
    if (force) {
      // Empty answers can skip voting entirely. Resolve an unambiguous leftover
      // pair after the round, while preserving separate repeated-prompt matches.
      for (const pool of this.#answerPools.values()) {
        const assigned = new Set([...this.#normal.values()].filter(group => group.pool === pool)
          .flatMap(group => [...group.answers.keys()]));
        const remaining = [...pool.answers.values()].filter(answer => !assigned.has(answer.playerId));
        if (remaining.length !== 2) continue;
        const accumulator = this.#normalForVote(pool.round, pool.prompt, []);
        accumulator.answers = new Map(remaining.map(answer => [answer.playerId, answer]));
      }
    }
    for (const accumulator of this.#normal.values()) {
      if (accumulator.emitted || accumulator.answers.size !== 2) continue;
      const expectedVotes = Math.max(0, playerCount - 2);
      if (!force && (playerCount < 3 || accumulator.votes.size < expectedVotes)) continue;
      const matchup = this.#buildMatchup(accumulator);
      accumulator.emitted = true;
      this.#push({ type: "matchup.resolved", gameId: this.gameId, matchup, at }, emitted);
    }

    if (normalOnly) return;
    const final = this.#thriplash;
    if (!final || final.emitted || final.entries.size === 0) return;
    const groupSizes = new Map<string, number>();
    for (const entry of final.entries.values()) {
      const prompt = normalizedPrompt(entry.prompt ?? final.prompt);
      groupSizes.set(prompt, (groupSizes.get(prompt) ?? 0) + 1);
    }
    const expectedVotes = groupSizes.size === 1 && [...groupSizes.values()][0] === playerCount
      ? playerCount
      : [...groupSizes.values()].reduce((sum, size) => sum + Math.max(0, playerCount - size), 0);
    if (!force && (
      playerCount === 0
      || final.entries.size < playerCount
      || final.votes.size < expectedVotes
    )) return;
    final.emitted = true;
    this.#push({
      type: "thriplash.resolved",
      gameId: this.gameId,
      thriplash: this.#buildThriplash(final),
      at,
    }, emitted);
  }

  #buildMatchup(accumulator: NormalAccumulator): Matchup {
    const index = this.#ensureMatchupIndex(accumulator);
    const answers = this.#orderedAnswers(accumulator);
    const votes = [...accumulator.votes.values()].flatMap((observation): Vote[] => {
      const choice = answerIndex(answers, observation.answerText);
      return choice < 0 ? [] : [{ voterId: observation.voterId, population: "player", choice }];
    });
    return {
      id: `${this.gameId}:r${accumulator.round}:m${index}`,
      gameId: this.gameId,
      round: accumulator.round,
      index,
      prompt: accumulator.prompt,
      answers,
      votes,
    };
  }

  #ensureMatchupIndex(accumulator: NormalAccumulator): number {
    accumulator.index ??= this.#nextMatchupIndex[accumulator.round]++;
    return accumulator.index;
  }

  #orderedAnswers(accumulator: NormalAccumulator): [Answer, Answer] {
    const owned = this.#sortBySeat([...accumulator.answers.values()], (answer) => answer.playerId);
    const presentation = accumulator.requests.values().next().value as VoteRequest | undefined;
    if (!presentation || presentation.options.length !== 2) return tuple2(owned);

    const remaining = [...owned];
    // Reserve exact matches before assigning game-generated fallback text.
    // A fallback shown first must not take the other answer's owner.
    const ordered = presentation.options.map((option): Answer | undefined => {
      const index = remaining.findIndex((answer) => normalized(answer.text) === normalized(option));
      return index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    });
    for (const [index, option] of presentation.options.entries()) {
      if (ordered[index]) continue;
      const unmatched = remaining.shift();
      if (unmatched) ordered[index] = { ...unmatched, text: option };
    }
    return ordered.length === 2 && ordered.every((answer): answer is Answer => answer !== undefined)
      ? tuple2(ordered) : tuple2(owned);
  }

  #buildThriplash(accumulator: ThriplashAccumulator): Thriplash {
    const entries = this.#sortBySeat([...accumulator.entries.values()], (entry) => entry.playerId);
    const votes = [...accumulator.votes.values()].flatMap((observation): Vote[] => {
      const choice = entries.findIndex((entry) => (
        normalizedPrompt(entry.prompt ?? accumulator.prompt) === normalizedPrompt(observation.prompt)
        && normalized(entry.lines.join("\n")) === normalized(observation.answerText)
      ));
      return choice < 0 ? [] : [{ voterId: observation.voterId, population: "player", choice }];
    });
    return { gameId: this.gameId, prompt: accumulator.prompt, entries, votes };
  }

  #sortBySeat<T>(values: T[], playerId: (value: T) => string): T[] {
    const positions = new Map(this.#playerOrder.map((id, index) => [id, index]));
    return values.sort((left, right) => (positions.get(playerId(left)) ?? Number.MAX_SAFE_INTEGER)
      - (positions.get(playerId(right)) ?? Number.MAX_SAFE_INTEGER));
  }

  #push(event: GameEvent, emitted: GameEvent[]): void {
    emitted.push(event);
    this.emit("event", event);
    this.#options.onEvent?.(event);
  }
}

function normalKey(round: 1 | 2, prompt: string): string {
  return `${round}\u0000${normalizedPrompt(prompt)}`;
}

function finalVoteKey(prompt: string, playerId: string): string {
  return `${normalizedPrompt(prompt)}\u0000${playerId}`;
}

function normalized(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function normalizedPrompt(value: string): string {
  return normalized(canonicalPrompt(value));
}

function canonicalPrompt(value: string): string {
  return value.replace(/\s*vote for your favorite\s*$/i, "").trim();
}

function answerIndex(answers: readonly [Answer, Answer], text: string): number {
  return answers.findIndex((answer) => normalized(answer.text) === normalized(text));
}

function voteRequest(options: readonly string[], rawChoices: unknown): VoteRequest {
  const choiceKeys: Array<string | number> = [];
  if (Array.isArray(rawChoices)) {
    rawChoices.forEach((candidate, position) => {
      if (typeof candidate === "string") {
        choiceKeys.push(position);
        return;
      }
      if (!isRecord(candidate) || candidate.disabled === true || candidate.visible === false) return;
      choiceKeys.push(typeof candidate.key === "string" || typeof candidate.key === "number"
        ? candidate.key
        : position);
    });
  }
  return {
    options: [...options],
    choiceKeys: choiceKeys.length === options.length ? choiceKeys : options.map((_option, index) => index),
  };
}

function selectedAnswer(
  request: VoteRequest | undefined,
  selectedIndex: number,
  choiceKey: string | number | undefined,
): string {
  if (!request) return "";
  const keyedIndex = choiceKey === undefined
    ? -1
    : request.choiceKeys.findIndex((candidate) => candidate === choiceKey);
  return request.options[keyedIndex >= 0 ? keyedIndex : selectedIndex] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tuple2(values: readonly Answer[]): [Answer, Answer] {
  const first = values[0];
  const second = values[1];
  if (!first || !second) throw new Error("A resolved Quiplash matchup requires exactly two answers");
  return [first, second];
}

function tuple3(values: readonly string[]): [string, string, string] {
  return [values[0] ?? "", values[1] ?? "", values[2] ?? ""];
}
