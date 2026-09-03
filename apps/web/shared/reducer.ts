import type { AnyEvent, Game, GameEvent, PlayerRef, StreamEvent } from "@quiparena/core";

import type { AnswerTrace, LivePlayerState, LiveState } from "./types.js";

const STREAM_EVENT_TYPES = new Set<StreamEvent["type"]>([
  "thinking.delta",
  "answer.draft",
  "trace.completed",
]);

export function isGameEvent(event: AnyEvent): event is GameEvent {
  return !STREAM_EVENT_TYPES.has(event.type as StreamEvent["type"]);
}

export function createEmptyLiveState(): LiveState {
  return {
    gameId: null,
    roomCode: null,
    startedAt: null,
    endedAt: null,
    updatedAt: null,
    round: null,
    phase: "waiting",
    playerOrder: [],
    players: {},
    currentVote: null,
    matchups: [],
    thriplash: null,
    finalScores: null,
    traces: {},
    error: null,
  };
}

export function labForModel(modelId: string | null): string {
  const provider = modelId?.split("/")[0]?.toLowerCase();
  const labs: Record<string, string> = {
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    google: "Google",
    meta: "Meta",
    "meta-llama": "Meta",
    mistralai: "Mistral AI",
    openai: "OpenAI",
    qwen: "Alibaba",
    "x-ai": "xAI",
  };
  return provider ? (labs[provider] ?? titleCase(provider)) : "Human";
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function colorForPlayer(player: PlayerRef): string {
  const source = player.modelId ?? player.id;
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${Math.abs(hash) % 360} 62% 58%)`;
}

function createPlayerState(player: PlayerRef): LivePlayerState {
  return {
    player,
    lab: labForModel(player.modelId),
    avatarColor: colorForPlayer(player),
    activity: "waiting",
    prompt: null,
    reasoning: "",
    draft: null,
    answer: null,
    vote: null,
  };
}

function updatePlayer(
  state: LiveState,
  playerId: string,
  update: (player: LivePlayerState) => LivePlayerState,
): LiveState {
  const player = state.players[playerId];
  if (!player) return state;
  return {
    ...state,
    players: { ...state.players, [playerId]: update(player) },
  };
}

function addTrace(state: LiveState, trace: AnswerTrace): LiveState {
  const existing = state.traces[trace.playerId] ?? [];
  const withoutDuplicate = existing.filter((item) => item.prompt !== trace.prompt);
  return {
    ...state,
    traces: {
      ...state.traces,
      [trace.playerId]: [...withoutDuplicate, trace],
    },
  };
}

export function reduceLiveState(previous: LiveState, event: AnyEvent): LiveState {
  if (event.type === "game.created") {
    // Every harness seat announces the game; only the first announcement resets state.
    if (previous.gameId === event.gameId) return previous;
    return {
      ...createEmptyLiveState(),
      gameId: event.gameId,
      roomCode: event.roomCode,
      updatedAt: event.at,
    };
  }

  if (previous.gameId !== event.gameId) return previous;
  let state: LiveState = { ...previous, updatedAt: event.at };

  switch (event.type) {
    case "player.joined": {
      const exists = Boolean(state.players[event.player.id]);
      return {
        ...state,
        playerOrder: exists ? state.playerOrder : [...state.playerOrder, event.player.id],
        players: {
          ...state.players,
          [event.player.id]: createPlayerState(event.player),
        },
      };
    }
    case "game.started":
      return { ...state, startedAt: event.at, phase: "playing" };
    case "round.started":
      return {
        ...state,
        round: event.round,
        phase: "playing",
        currentVote: null,
        players: Object.fromEntries(
          Object.entries(state.players).map(([id, player]) => [id, {
            ...player,
            activity: "waiting" as const,
            prompt: null,
            reasoning: "",
            draft: null,
            answer: null,
            vote: null,
          }]),
        ),
      };
    case "prompt.dealt":
      return updatePlayer(state, event.playerId, (player) => ({
        ...player,
        activity: "thinking",
        prompt: event.prompt,
        reasoning: "",
        draft: null,
        answer: null,
        vote: null,
      }));
    case "thinking.delta":
      return updatePlayer(state, event.playerId, (player) => ({
        ...player,
        activity: player.activity === "voting" || player.activity === "voted" ? "voting" : "thinking",
        reasoning: `${player.reasoning}${event.text}`.slice(-24_000),
      }));
    case "answer.draft":
      return updatePlayer(state, event.playerId, (player) => ({
        ...player,
        activity: "drafting",
        draft: event.text,
      }));
    case "trace.completed": {
      state = updatePlayer(state, event.playerId, (player) => ({
        ...player,
        reasoning: event.reasoning || player.reasoning,
        answer: player.vote?.prompt === event.prompt ? player.answer : event.answer,
      }));
      return addTrace(state, {
        playerId: event.playerId,
        prompt: event.prompt,
        reasoning: event.reasoning,
        answer: event.answer,
        at: event.at,
      });
    }
    case "answer.submitted":
      return updatePlayer(state, event.playerId, (player) => ({
        ...player,
        activity: "submitted",
        prompt: event.prompt,
        answer: event.answer,
        draft: typeof event.answer === "string" ? event.answer : event.answer.join(" / "),
      }));
    case "vote.requested": {
      const sameVote = state.currentVote?.prompt === event.prompt;
      state = {
        ...state,
        phase: "voting",
        currentVote: sameVote && state.currentVote
          ? state.currentVote
          : {
              round: event.round,
              prompt: event.prompt,
              options: [...event.options],
              votes: {},
              resolved: null,
            },
      };
      return updatePlayer(state, event.playerId, (player) => ({
        ...player,
        activity: "voting",
        prompt: event.prompt,
        reasoning: "",
        vote: { prompt: event.prompt, options: [...event.options], choice: null },
      }));
    }
    case "vote.cast": {
      state = updatePlayer(state, event.playerId, (player) => ({
        ...player,
        activity: "voted",
        vote: player.vote
          ? { ...player.vote, choice: event.choice }
          : { prompt: event.prompt, options: [], choice: event.choice },
      }));
      if (state.currentVote?.prompt !== event.prompt) return state;
      return {
        ...state,
        currentVote: {
          ...state.currentVote,
          votes: { ...state.currentVote.votes, [event.playerId]: event.choice },
        },
      };
    }
    case "matchup.resolved": {
      const matchups = state.matchups.some((matchup) => matchup.id === event.matchup.id)
        ? state.matchups
        : [...state.matchups, event.matchup];
      return {
        ...state,
        phase: "voting",
        matchups,
        currentVote: {
          round: event.matchup.round,
          prompt: event.matchup.prompt,
          options: event.matchup.answers.map((answer) => answer.text),
          votes: Object.fromEntries(
            event.matchup.votes
              .filter((vote) => vote.population === "player")
              .map((vote) => [vote.voterId, vote.choice]),
          ),
          resolved: event.matchup,
        },
      };
    }
    case "thriplash.resolved":
      return { ...state, thriplash: event.thriplash, phase: "playing" };
    case "game.ended":
      return {
        ...state,
        endedAt: event.at,
        phase: "ended",
        finalScores: event.finalScores ?? state.finalScores,
        players: Object.fromEntries(
          Object.entries(state.players).map(([id, player]) => [id, { ...player, activity: "done" as const }]),
        ),
      };
    case "harness.error":
      // Per-seat trouble (a model missing its deadline, a watchdog nudge) is not a game failure.
      return { ...state, error: event.message };
    case "answer.rejected":
      // The harness re-asks the player; the eventual answer.submitted updates the card.
      return state;
  }
}

export function replayEvents(events: readonly AnyEvent[]): LiveState {
  return events.reduce(reduceLiveState, createEmptyLiveState());
}

export function liveStateToGame(state: LiveState): Game | null {
  if (!state.gameId || !state.roomCode) return null;
  const players = state.playerOrder
    .map((id) => state.players[id]?.player)
    .filter((player): player is PlayerRef => Boolean(player));
  return {
    id: state.gameId,
    roomCode: state.roomCode,
    startedAt: state.startedAt ?? state.updatedAt ?? new Date(0).toISOString(),
    players,
    matchups: state.matchups,
    ...(state.endedAt ? { endedAt: state.endedAt } : {}),
    ...(state.thriplash ? { thriplash: state.thriplash } : {}),
    ...(state.finalScores ? { finalScores: state.finalScores } : {}),
  };
}
