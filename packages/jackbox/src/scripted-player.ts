import type { Player, PlayerContext } from "./player.js";

export interface ScriptedPlayerOptions {
  answers?: readonly string[];
  finalAnswers?: readonly [string, string, string][];
  voteOffset?: number;
}

const DEFAULT_ANSWERS = [
  "A tiny horse with a law degree",
  "The moon's least convincing alibi",
  "Three raccoons filing their taxes",
  "An emotional-support foghorn",
  "Soup with excellent credit",
  "The forbidden fourth meal",
] as const;

export class ScriptedPlayer implements Player {
  readonly name: string;
  readonly modelId = null;
  #answerIndex = 0;
  #finalIndex = 0;
  readonly #answers: readonly string[];
  readonly #finalAnswers: readonly [string, string, string][];
  readonly #voteOffset: number;

  constructor(name: string, options: ScriptedPlayerOptions = {}) {
    this.name = name;
    this.#answers = options.answers?.length ? options.answers : DEFAULT_ANSWERS;
    this.#finalAnswers = options.finalAnswers?.length
      ? options.finalAnswers
      : [["First came the ducks", "Then came the paperwork", "Nobody insured the volcano"]];
    this.#voteOffset = options.voteOffset ?? stableHash(name);
  }

  async answer(_prompt: string, _ctx: PlayerContext): Promise<string> {
    const answer = this.#answers[this.#answerIndex % this.#answers.length] ?? "A very specific goose";
    this.#answerIndex += 1;
    return `${this.name}: ${answer}`;
  }

  async answerFinal(_prompt: string, _ctx: PlayerContext): Promise<[string, string, string]> {
    const answer = this.#finalAnswers[this.#finalIndex % this.#finalAnswers.length]
      ?? ["One", "Two", "Three"];
    this.#finalIndex += 1;
    return answer.map((line, index) => `${this.name} ${index + 1}: ${line}`) as [string, string, string];
  }

  async vote(prompt: string, options: string[], _ctx: PlayerContext): Promise<number> {
    if (options.length === 0) return 0;
    return (stableHash(prompt) + this.#voteOffset) % options.length;
  }
}

function stableHash(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return hash;
}
