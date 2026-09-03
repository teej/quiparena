import type {
  Answer,
  AnyEvent,
  Game,
  Matchup,
  PlayerRef,
  RoundNumber,
  Thriplash,
  Vote,
} from "@quiparena/core";

import { isGameEvent, liveStateToGame, replayEvents } from "../shared/reducer.js";
import type { AnswerTrace, ArchivedGame } from "../shared/types.js";

export interface DemoFixture {
  events: AnyEvent[];
  archive: ArchivedGame;
}

const DEMO_MODELS: ReadonlyArray<readonly [string, string]> = [
  ["openai/gpt-5.5", "GPT-5.5"],
  ["anthropic/claude-opus-4.6", "Opus 4.6"],
  ["google/gemini-3.1-pro", "Gemini 3.1"],
  ["x-ai/grok-4.1", "Grok 4.1"],
  ["deepseek/deepseek-v3.2", "DeepSeek"],
  ["meta-llama/llama-4-maverick", "Llama 4"],
  ["mistralai/mistral-large", "Mistral"],
  ["qwen/qwen3-max", "Qwen 3"],
];

const MATCHUP_DATA: ReadonlyArray<{
  round: 1 | 2;
  prompt: string;
  answers: readonly [string, string];
  authors: readonly [number, number];
}> = [
  {
    round: 1,
    prompt: "The least reassuring thing to hear from your dentist",
    answers: ["This tooth has chosen violence", "Good news: I watched a tutorial"],
    authors: [0, 1],
  },
  {
    round: 1,
    prompt: "A terrible slogan for a time machine",
    answers: ["Yesterday's bugs, shipped tomorrow", "Terms apply retroactively"],
    authors: [2, 3],
  },
  {
    round: 2,
    prompt: "The secret final level of adulthood",
    answers: ["Calling the plumber before making it worse", "A group chat about lower back pain"],
    authors: [4, 5],
  },
  {
    round: 2,
    prompt: "A warning label every group chat should have",
    answers: ["Screenshots may outlive friendships", "Contains 40% plans, 60% reactions"],
    authors: [6, 7],
  },
];

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function words(value: string): string[] {
  return value.split(/(?<=\s)/).filter(Boolean);
}

export function createDemoFixture(seed = 20260902): DemoFixture {
  const random = mulberry32(seed);
  const gameId = `demo-${seed.toString(36)}`;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const roomCode = Array.from({ length: 4 }, () => alphabet[Math.floor(random() * alphabet.length)] ?? "Q").join("");
  const players: PlayerRef[] = DEMO_MODELS.map(([modelId, name], index) => ({
    id: `p${index + 1}`,
    name,
    modelId,
  }));
  const events: AnyEvent[] = [];
  const scores: Record<string, number> = Object.fromEntries(players.map((player) => [player.id, 0]));
  const origin = Date.UTC(2026, 8, 2, 19, 0, 0) + (seed % 10_000) * 1_000;
  let tick = 0;
  const at = (): string => new Date(origin + tick++ * 1_000).toISOString();
  const push = (event: AnyEvent): void => {
    events.push(event);
  };

  push({ type: "game.created", gameId, roomCode, at: at() });
  for (const player of players) push({ type: "player.joined", gameId, player, at: at() });
  push({ type: "game.started", gameId, at: at() });

  let activeRound: RoundNumber | null = null;
  MATCHUP_DATA.forEach((definition, matchupIndex) => {
    if (activeRound !== definition.round) {
      activeRound = definition.round;
      push({ type: "round.started", gameId, round: definition.round, at: at() });
    }
    const answers = definition.authors.map((authorIndex, answerIndex): Answer => {
      const player = players[authorIndex];
      if (!player) throw new Error("Demo author is missing");
      const answer = definition.answers[answerIndex] ?? "A mysterious loading screen";
      const reasoning = `Find a specific comic turn, keep it compact, then land on ${answer.toLowerCase()}.`;
      push({
        type: "prompt.dealt",
        gameId,
        round: definition.round,
        playerId: player.id,
        prompt: definition.prompt,
        deadlineMs: origin + tick * 1_000 + 30_000,
        at: at(),
      });
      for (const text of words(reasoning)) {
        push({ type: "thinking.delta", gameId, playerId: player.id, text, at: at() });
      }
      push({ type: "answer.draft", gameId, playerId: player.id, text: answer, at: at() });
      push({
        type: "trace.completed",
        gameId,
        playerId: player.id,
        prompt: definition.prompt,
        reasoning,
        answer,
        usage: { inputTokens: 84, outputTokens: 31, reasoningTokens: 18 },
        at: at(),
      });
      push({
        type: "answer.submitted",
        gameId,
        round: definition.round,
        playerId: player.id,
        prompt: definition.prompt,
        answer,
        blank: false,
        latencyMs: 3_200 + Math.floor(random() * 2_400),
        at: at(),
      });
      return { playerId: player.id, text: answer, blank: false };
    }) as [Answer, Answer];

    const votes: Vote[] = [];
    players.forEach((voter, voterIndex) => {
      if (definition.authors.includes(voterIndex)) return;
      const choice = random() > 0.43 ? 1 : 0;
      push({
        type: "vote.requested",
        gameId,
        round: definition.round,
        playerId: voter.id,
        prompt: definition.prompt,
        options: [...definition.answers],
        deadlineMs: origin + tick * 1_000 + 20_000,
        at: at(),
      });
      const reasoning = choice === 0 ? "The first answer has the sharper surprise." : "The second answer has the cleaner punchline.";
      for (const text of words(reasoning)) {
        push({ type: "thinking.delta", gameId, playerId: voter.id, text, at: at() });
      }
      push({
        type: "trace.completed",
        gameId,
        playerId: voter.id,
        prompt: definition.prompt,
        reasoning,
        answer: String(choice),
        at: at(),
      });
      push({
        type: "vote.cast",
        gameId,
        round: definition.round,
        playerId: voter.id,
        prompt: definition.prompt,
        choice,
        at: at(),
      });
      votes.push({ voterId: voter.id, population: "player", choice });
    });

    const totals = [0, 0];
    for (const vote of votes) totals[vote.choice] = (totals[vote.choice] ?? 0) + (vote.weight ?? 1);
    const multiplier = definition.round;
    answers.forEach((answer, index) => {
      scores[answer.playerId] = (scores[answer.playerId] ?? 0) + (totals[index] ?? 0) * 100 * multiplier;
    });
    const matchup: Matchup = {
      id: `${gameId}-m${matchupIndex + 1}`,
      gameId,
      round: definition.round,
      index: matchupIndex % 2,
      prompt: definition.prompt,
      answers,
      votes,
      scores: Object.fromEntries(answers.map((answer) => [answer.playerId, scores[answer.playerId] ?? 0])),
    };
    push({ type: "matchup.resolved", gameId, matchup, at: at() });
  });

  push({ type: "round.started", gameId, round: 3, at: at() });
  const finalPrompt = "Three rejected features from the next smartphone";
  const entries = players.map((player, index) => {
    const lines: [string, string, string] = [
      `A tiny fax machine ${index + 1}`,
      "Airplane mode, but literal",
      "One more camera for emotional support",
    ];
    const reasoning = "Use a mundane tech annoyance, escalate it, and finish with an overly human feature request.";
    push({
      type: "prompt.dealt",
      gameId,
      round: 3,
      playerId: player.id,
      prompt: finalPrompt,
      deadlineMs: origin + tick * 1_000 + 35_000,
      at: at(),
    });
    for (const text of words(reasoning)) push({ type: "thinking.delta", gameId, playerId: player.id, text, at: at() });
    push({ type: "answer.draft", gameId, playerId: player.id, text: lines.join(" / "), at: at() });
    push({ type: "trace.completed", gameId, playerId: player.id, prompt: finalPrompt, reasoning, answer: lines.join("\n"), at: at() });
    push({ type: "answer.submitted", gameId, round: 3, playerId: player.id, prompt: finalPrompt, answer: lines, blank: false, latencyMs: 5_000 + Math.floor(random() * 3_000), at: at() });
    return { playerId: player.id, lines };
  });
  const finalVotes: Vote[] = players.map((player, index) => {
    const choice = (index + 3) % players.length;
    return { voterId: player.id, population: "player", choice };
  });
  for (const vote of finalVotes) scores[players[vote.choice]?.id ?? ""] = (scores[players[vote.choice]?.id ?? ""] ?? 0) + 300;
  const thriplash: Thriplash = { gameId, prompt: finalPrompt, entries, votes: finalVotes, scores: { ...scores } };
  push({ type: "thriplash.resolved", gameId, thriplash, at: at() });
  push({ type: "game.ended", gameId, finalScores: { ...scores }, at: at() });

  const live = replayEvents(events);
  const game = liveStateToGame(live);
  if (!game) throw new Error("Demo fixture did not produce a game");
  const traces: Record<string, AnswerTrace[]> = structuredClone(live.traces);
  return {
    events,
    archive: {
      game: game as Game,
      events: events.filter(isGameEvent),
      traces,
    },
  };
}
