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
  readonly #nextMatchupIndex: Record<1 | 2, number> = { 1: 0, 2: 0 };
  #thriplash?: ThriplashAccumulator;
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
      case "player.joined":
        if (!this.#players.has(event.player.id)) this.#playerOrder.push(event.player.id);
        this.#players.set(event.player.id, event.player);
        break;
      case "answer.submitted":
        if (event.round === 3 && Array.isArray(event.answer)) {
          const accumulator = this.#thriplashFor(event.prompt);
          accumulator.entries.set(event.playerId, {
            playerId: event.playerId,
            lines: tuple3(event.answer),
          });
        } else if ((event.round === 1 || event.round === 2) && typeof event.answer === "string") {
          const accumulator = this.#normalFor(event.round, event.prompt);
          accumulator.answers.set(event.playerId, {
            playerId: event.playerId,
            text: event.answer,
            blank: event.blank,
          });
        }
        break;
      case "vote.requested": {
        const request = voteRequest(event.options, event.controller?.choices);
        if (event.round === 3) {
          this.#thriplashFor(event.prompt).requests.set(event.playerId, request);
        } else {
          const accumulator = this.#findNormal(event.round, event.prompt, event.options)
            ?? this.#normalFor(event.round, event.prompt);
          this.#ensureMatchupIndex(accumulator);
          accumulator.requests.set(event.playerId, request);
        }
        break;
      }
      case "vote.cast": {
        const observation: VoteObservation = {
          voterId: event.playerId,
          answerText: event.answer ?? "",
          ...(event.choiceKey === undefined ? {} : { choiceKey: event.choiceKey }),
        };
        if (event.round === 3) {
          const accumulator = this.#thriplashFor(event.prompt);
          const request = accumulator.requests.get(event.playerId);
          if (!observation.answerText) observation.answerText = selectedAnswer(request, event.choice, event.choiceKey);
          accumulator.votes.set(event.playerId, observation);
        } else {
          const requestOptions = this.#normal.get(normalKey(event.round, event.prompt))
            ?.requests.get(event.playerId)?.options ?? [];
          const accumulator = this.#findNormal(
            event.round,
            event.prompt,
            event.answer ? [event.answer] : requestOptions,
          )
            ?? this.#normalFor(event.round, event.prompt);
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

  #normalFor(round: 1 | 2, prompt: string): NormalAccumulator {
    const key = normalKey(round, prompt);
    let accumulator = this.#normal.get(key);
    if (!accumulator) {
      accumulator = {
        round,
        prompt: canonicalPrompt(prompt),
        answers: new Map(),
        requests: new Map(),
        votes: new Map(),
        emitted: false,
      };
      this.#normal.set(key, accumulator);
    }
    return accumulator;
  }

  #findNormal(round: 1 | 2, prompt: string, options: readonly string[]): NormalAccumulator | undefined {
    const exact = this.#normal.get(normalKey(round, prompt));
    if (exact) return exact;
    if (options.length === 0) return undefined;
    const candidates = [...this.#normal.values()].filter((candidate) => {
      if (candidate.round !== round || candidate.emitted) return false;
      const answerTexts = [...candidate.answers.values()].map((answer) => normalized(answer.text));
      return options.some((option) => answerTexts.includes(normalized(option)));
    });
    return candidates.length === 1 ? candidates[0] : undefined;
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

  #flushResolved(at: string, emitted: GameEvent[], force: boolean): void {
    const playerCount = this.#options.expectedPlayerCount ?? this.#players.size;
    for (const accumulator of this.#normal.values()) {
      if (accumulator.emitted || accumulator.answers.size !== 2) continue;
      const expectedVotes = Math.max(0, playerCount - 2);
      if (!force && (playerCount < 3 || accumulator.votes.size < expectedVotes)) continue;
      const matchup = this.#buildMatchup(accumulator);
      accumulator.emitted = true;
      this.#push({ type: "matchup.resolved", gameId: this.gameId, matchup, at }, emitted);
    }

    const final = this.#thriplash;
    if (!final || final.emitted || final.entries.size === 0) return;
    if (!force && (playerCount === 0 || final.entries.size < playerCount || final.votes.size < playerCount)) return;
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
    const ordered: Answer[] = [];
    for (const option of presentation.options) {
      const index = remaining.findIndex((answer) => normalized(answer.text) === normalized(option));
      if (index >= 0) {
        const [matched] = remaining.splice(index, 1);
        if (matched) ordered.push(matched);
      } else {
        const unmatched = remaining.shift();
        if (unmatched) ordered.push({ ...unmatched, text: option });
      }
    }
    return ordered.length === 2 ? tuple2(ordered) : tuple2(owned);
  }

  #buildThriplash(accumulator: ThriplashAccumulator): Thriplash {
    const entries = this.#sortBySeat([...accumulator.entries.values()], (entry) => entry.playerId);
    const votes = [...accumulator.votes.values()].flatMap((observation): Vote[] => {
      const choice = entries.findIndex((entry) => normalized(entry.lines.join("\n")) === normalized(observation.answerText));
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
