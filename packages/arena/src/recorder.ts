import { createHash } from "node:crypto";

import type {
  Answer as GameAnswer,
  Game,
  GameEvent,
  Matchup,
  StreamEvent,
  Thriplash,
  Vote,
} from "@quiparena/core";
import { and, asc, eq } from "drizzle-orm";

import type { ArenaDatabaseClient } from "./db/client.js";
import {
  placementsFromScores,
  scoreGame,
  scoreMatchup,
  scoreThriplash,
} from "./scoring.js";
import {
  answers,
  events,
  gamePlayers,
  games,
  matchups,
  models,
  thriplashes,
  traces,
  votes,
} from "./db/schema.js";

type TraceEvent = Extract<StreamEvent, { type: "trace.completed" }>;
type AudienceVotesEvent = Extract<GameEvent, { type: "audience.votes" }>;
type MatchupObservedEvent = Extract<GameEvent, { type: "matchup.observed" }>;
type TraceKind = "answer" | "final" | "vote";

interface SubmissionMeta {
  blank: boolean;
  latencyMs: number;
}

interface PendingObservedMatchup {
  observed: MatchupObservedEvent;
  audienceVotes?: AudienceVotesEvent;
}

export interface RecorderLogger {
  warn(message: string): void;
}

export interface RecorderOptions {
  logger?: RecorderLogger;
}

const DEFAULT_RECORDER_LOGGER: RecorderLogger = {
  warn: (message) => console.warn(message),
};

function eventDate(at: string): Date {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid event timestamp: ${at}`);
  return date;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function submissionKey(gameId: string, playerId: string, prompt: string): string {
  return canonical([gameId, playerId, prompt]);
}

function thriplashId(gameId: string): string {
  return `${gameId}:thriplash`;
}

function displayName(value: string): string {
  return Array.from(value.trim() || "Player").slice(0, 12).join("");
}

function normalizedText(value: string): string {
  return decodeHtml(value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li)>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizedPrompt(value: string): string {
  return normalizedText(value).replace(/\s*vote for your favorite\s*$/i, "").trim();
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

function matchedAnswerIndexes(
  observed: readonly [string, string],
  stored: readonly { answerIndex: number; text: string }[],
): [number, number] | undefined {
  const used = new Set<number>();
  const matched = observed.map((answer) => {
    const row = stored.find((candidate) => (
      !used.has(candidate.answerIndex) && normalizedText(candidate.text) === normalizedText(answer)
    ));
    if (row) used.add(row.answerIndex);
    return row?.answerIndex;
  });
  return matched[0] === undefined || matched[1] === undefined
    ? undefined
    : [matched[0], matched[1]];
}

function modelLab(slug: string): string {
  return slug.split("/", 1)[0]?.trim() || "unknown";
}

function hasGameId(event: GameEvent): event is GameEvent & { gameId: string } {
  return "gameId" in event && typeof event.gameId === "string";
}

function traceUsage(event: TraceEvent): Record<string, unknown> | null {
  return event.usage ? { ...event.usage } : null;
}

/** Persist normalized game state plus the immutable raw GameEvent stream. */
export class Recorder {
  private readonly submissions = new Map<string, SubmissionMeta>();
  private readonly traceKinds = new Map<string, TraceKind>();
  private readonly pendingAudienceVotes = new Map<string, AudienceVotesEvent[]>();
  private readonly pendingObservedMatchups = new Map<string, PendingObservedMatchup[]>();
  private readonly logger: RecorderLogger;

  constructor(readonly db: ArenaDatabaseClient, options: RecorderOptions = {}) {
    this.logger = options.logger ?? DEFAULT_RECORDER_LOGGER;
  }

  async consume(event: GameEvent | StreamEvent): Promise<void> {
    await this.record(event);
  }

  async record(event: GameEvent | StreamEvent): Promise<void> {
    if (event.type === "trace.completed") {
      await this.recordTrace(event);
      return;
    }
    if (event.type === "thinking.delta" || event.type === "answer.draft") return;

    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as ArenaDatabaseClient;
      if (hasGameId(event)) await this.ensureGame(db, event.gameId, event.at);
      await db.insert(events).values({
        gameId: hasGameId(event) ? event.gameId : null,
        type: event.type,
        payload: event,
        at: eventDate(event.at),
        eventKey: stableId("event", event),
      }).onConflictDoNothing({ target: events.eventKey });
      await this.normalize(db, event);
    });
  }

  async loadGame(gameId: string): Promise<Game | undefined> {
    return loadGame(this.db, gameId);
  }

  private async ensureGame(db: ArenaDatabaseClient, gameId: string, at: string): Promise<void> {
    await db.insert(games).values({
      id: gameId,
      roomCode: "",
      startedAt: eventDate(at),
      status: "created",
    }).onConflictDoNothing({ target: games.id });
  }

  private async normalize(db: ArenaDatabaseClient, event: GameEvent): Promise<void> {
    switch (event.type) {
      case "game.created":
        await db.insert(games).values({
          id: event.gameId,
          roomCode: event.roomCode,
          startedAt: eventDate(event.at),
          status: "created",
        }).onConflictDoUpdate({
          target: games.id,
          set: { roomCode: event.roomCode },
        });
        break;

      case "player.joined": {
        const modelSlug = event.player.modelId;
        if (modelSlug) {
          await db.insert(models).values({
            slug: modelSlug,
            displayName: displayName(event.player.name),
            lab: modelLab(modelSlug),
            enabled: true,
            config: {},
          }).onConflictDoNothing({ target: models.slug });
        }
        const existing = await db.select({ playerId: gamePlayers.playerId })
          .from(gamePlayers)
          .where(eq(gamePlayers.gameId, event.gameId));
        await db.insert(gamePlayers).values({
          gameId: event.gameId,
          playerId: event.player.id,
          name: displayName(event.player.name),
          modelSlug,
          seat: existing.length,
          vip: false,
        }).onConflictDoUpdate({
          target: [gamePlayers.gameId, gamePlayers.playerId],
          set: { name: displayName(event.player.name), modelSlug },
        });
        break;
      }

      case "game.started":
        await db.update(games).set({
          startedAt: eventDate(event.at),
          status: "running",
        }).where(eq(games.id, event.gameId));
        break;

      case "prompt.dealt":
        this.traceKinds.set(
          submissionKey(event.gameId, event.playerId, event.prompt),
          event.round === 3 ? "final" : "answer",
        );
        break;

      case "answer.submitted":
        this.submissions.set(submissionKey(event.gameId, event.playerId, event.prompt), {
          blank: event.blank,
          latencyMs: event.latencyMs,
        });
        break;

      case "vote.requested":
        this.traceKinds.set(submissionKey(event.gameId, event.playerId, event.prompt), "vote");
        break;

      case "matchup.resolved":
        await this.recordMatchup(db, event.matchup, event.at);
        await this.reconcileObservedMatchups(db, event.gameId);
        break;

      case "thriplash.resolved":
        await this.recordThriplash(db, event.thriplash, event.at);
        await this.reconcileObservedMatchups(db, event.gameId);
        break;

      case "audience.votes": {
        const pending = this.pendingAudienceVotes.get(event.gameId) ?? [];
        pending.push(event);
        this.pendingAudienceVotes.set(event.gameId, pending);
        break;
      }

      case "matchup.observed": {
        const voteEvents = this.pendingAudienceVotes.get(event.gameId) ?? [];
        const matching = voteEvents.filter((candidate) => (
          normalizedPrompt(candidate.prompt) === normalizedPrompt(event.prompt)
        ));
        this.pendingAudienceVotes.set(
          event.gameId,
          voteEvents.filter((candidate) => normalizedPrompt(candidate.prompt) !== normalizedPrompt(event.prompt)),
        );
        const pending = this.pendingObservedMatchups.get(event.gameId) ?? [];
        pending.push({
          observed: event,
          ...(matching.at(-1) === undefined ? {} : { audienceVotes: matching.at(-1)! }),
        });
        this.pendingObservedMatchups.set(event.gameId, pending);
        await this.reconcileObservedMatchups(db, event.gameId);
        break;
      }

      case "standings.observed":
        await this.recordObservedStandings(db, event);
        break;

      case "game.ended": {
        await this.reconcileObservedMatchups(db, event.gameId);
        const finalScores = await finalizeGameScores(db, event.gameId);
        await db.update(games).set({
          endedAt: eventDate(event.at),
          status: "completed",
          finalScores: finalScores ?? {},
        }).where(eq(games.id, event.gameId));
        await this.logScoreMismatches(db, event.gameId, finalScores ?? {});
        break;
      }

      case "round.started":
      case "scoreboard.observed":
      case "answer.rejected":
      case "vote.cast":
      case "harness.error":
        break;

      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  private async submissionMeta(
    db: ArenaDatabaseClient,
    gameId: string,
    playerId: string,
    prompt: string,
  ): Promise<SubmissionMeta | undefined> {
    const key = submissionKey(gameId, playerId, prompt);
    const cached = this.submissions.get(key);
    if (cached) return cached;

    const rows = await db.select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.gameId, gameId), eq(events.type, "answer.submitted")))
      .orderBy(asc(events.id));
    for (const row of rows) {
      const submitted = row.payload;
      if (submitted.type !== "answer.submitted") continue;
      this.submissions.set(
        submissionKey(submitted.gameId, submitted.playerId, submitted.prompt),
        { blank: submitted.blank, latencyMs: submitted.latencyMs },
      );
    }
    return this.submissions.get(key);
  }

  private async recordMatchup(db: ArenaDatabaseClient, matchup: Matchup, at: string): Promise<void> {
    matchup = scoreMatchup(matchup);
    await db.insert(matchups).values({
      id: matchup.id,
      gameId: matchup.gameId,
      round: matchup.round,
      index: matchup.index,
      prompt: matchup.prompt,
      scores: matchup.scores ?? null,
    }).onConflictDoUpdate({
      target: matchups.id,
      set: {
        round: matchup.round,
        index: matchup.index,
        prompt: matchup.prompt,
        scores: matchup.scores ?? null,
      },
    });

    for (const [answerIndex, answer] of matchup.answers.entries()) {
      const meta = await this.submissionMeta(
        db,
        matchup.gameId,
        answer.playerId,
        matchup.prompt,
      );
      await db.insert(answers).values({
        id: `${matchup.id}:answer:${answer.playerId}`,
        matchupId: matchup.id,
        thriplashId: null,
        gameId: matchup.gameId,
        playerId: answer.playerId,
        answerIndex,
        text: answer.text,
        blank: meta?.blank ?? answer.blank,
        lines: null,
        latencyMs: meta?.latencyMs ?? null,
      }).onConflictDoUpdate({
        target: answers.id,
        set: {
          answerIndex,
          text: answer.text,
          blank: meta?.blank ?? answer.blank,
          latencyMs: meta?.latencyMs ?? null,
        },
      });
    }
    await this.recordVotes(db, matchup.gameId, matchup.id, null, matchup.votes, at);
  }

  private async recordThriplash(db: ArenaDatabaseClient, thriplash: Thriplash, at: string): Promise<void> {
    thriplash = scoreThriplash(thriplash);
    const id = thriplashId(thriplash.gameId);
    await db.insert(thriplashes).values({
      id,
      gameId: thriplash.gameId,
      prompt: thriplash.prompt,
      scores: thriplash.scores ?? null,
    }).onConflictDoUpdate({
      target: thriplashes.id,
      set: { prompt: thriplash.prompt, scores: thriplash.scores ?? null },
    });

    for (const [answerIndex, entry] of thriplash.entries.entries()) {
      const meta = await this.submissionMeta(db, thriplash.gameId, entry.playerId, thriplash.prompt);
      await db.insert(answers).values({
        id: `${id}:answer:${entry.playerId}`,
        matchupId: null,
        thriplashId: id,
        gameId: thriplash.gameId,
        playerId: entry.playerId,
        answerIndex,
        text: entry.lines.join("\n"),
        blank: meta?.blank ?? entry.lines.every((line) => line.length === 0),
        lines: entry.lines,
        latencyMs: meta?.latencyMs ?? null,
      }).onConflictDoUpdate({
        target: answers.id,
        set: {
          answerIndex,
          text: entry.lines.join("\n"),
          blank: meta?.blank ?? entry.lines.every((line) => line.length === 0),
          lines: entry.lines,
          latencyMs: meta?.latencyMs ?? null,
        },
      });
    }
    await this.recordVotes(db, thriplash.gameId, null, id, thriplash.votes, at);
  }

  private async recordVotes(
    db: ArenaDatabaseClient,
    gameId: string,
    matchupIdValue: string | null,
    thriplashIdValue: string | null,
    gameVotes: readonly Vote[],
    at: string,
  ): Promise<void> {
    const players = await db.select({
      playerId: gamePlayers.playerId,
      modelSlug: gamePlayers.modelSlug,
    }).from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
    const modelByPlayer = new Map(players.map((player) => [player.playerId, player.modelSlug]));

    for (const [voteIndex, vote] of gameVotes.entries()) {
      const source = vote.population === "audience"
        ? "game" as const
        : modelByPlayer.get(vote.voterId)
          ? "model" as const
          : "game" as const;
      const identity = {
        gameId,
        matchupId: matchupIdValue,
        thriplashId: thriplashIdValue,
        voteIndex,
        vote,
      };
      await db.insert(votes).values({
        id: stableId("vote", identity),
        gameId,
        matchupId: matchupIdValue,
        thriplashId: thriplashIdValue,
        voterId: vote.voterId || null,
        population: vote.population,
        source,
        choice: vote.choice,
        weight: vote.weight ?? 1,
        createdAt: eventDate(at),
      }).onConflictDoNothing({ target: votes.id });
    }
  }

  private async recordObservedStandings(
    db: ArenaDatabaseClient,
    event: Extract<GameEvent, { type: "standings.observed" }>,
  ): Promise<void> {
    await db.update(games).set({ observedScores: event.standings })
      .where(eq(games.id, event.gameId));
    const players = await db.select({
      playerId: gamePlayers.playerId,
      name: gamePlayers.name,
    }).from(gamePlayers).where(eq(gamePlayers.gameId, event.gameId));
    const playersByName = new Map(players.map((player) => [normalizedText(player.name), player]));
    for (const standing of event.standings) {
      const player = playersByName.get(normalizedText(standing.name));
      if (!player) {
        this.logger.warn(
          `[quiparena/recorder] observed standing did not match a seat: game=${event.gameId} name=${standing.name}`,
        );
        continue;
      }
      await db.update(gamePlayers).set({
        observedScore: standing.score,
        observedPlacement: standing.placement,
      }).where(and(
        eq(gamePlayers.gameId, event.gameId),
        eq(gamePlayers.playerId, player.playerId),
      ));
    }
    const [storedGame] = await db.select({
      status: games.status,
      finalScores: games.finalScores,
    }).from(games).where(eq(games.id, event.gameId)).limit(1);
    if (storedGame?.status === "completed" && storedGame.finalScores) {
      await this.logScoreMismatches(db, event.gameId, storedGame.finalScores);
    }
  }

  private async reconcileObservedMatchups(
    db: ArenaDatabaseClient,
    gameId: string,
  ): Promise<void> {
    const pending = this.pendingObservedMatchups.get(gameId);
    if (!pending?.length) return;
    const [matchupRows, answerRows, thriplashRows] = await Promise.all([
      db.select().from(matchups).where(eq(matchups.gameId, gameId)),
      db.select().from(answers).where(eq(answers.gameId, gameId)),
      db.select().from(thriplashes).where(eq(thriplashes.gameId, gameId)).limit(1),
    ]);
    const unresolved: PendingObservedMatchup[] = [];

    for (const item of pending) {
      const observedAnswers = item.observed.answers;
      let target: {
        matchupId: string | null;
        thriplashId: string | null;
        choices: [number, number];
      } | undefined;

      for (const matchup of matchupRows) {
        if (normalizedPrompt(matchup.prompt) !== normalizedPrompt(item.observed.prompt)) continue;
        const storedAnswers = answerRows.filter((answer) => answer.matchupId === matchup.id);
        const choices = matchedAnswerIndexes(observedAnswers, storedAnswers);
        if (choices) {
          target = { matchupId: matchup.id, thriplashId: null, choices };
          break;
        }
      }

      const thriplash = thriplashRows[0];
      if (!target && thriplash
        && normalizedPrompt(thriplash.prompt) === normalizedPrompt(item.observed.prompt)) {
        const storedAnswers = answerRows.filter((answer) => answer.thriplashId === thriplash.id);
        const choices = matchedAnswerIndexes(observedAnswers, storedAnswers);
        if (choices) target = { matchupId: null, thriplashId: thriplash.id, choices };
      }

      if (!target) {
        unresolved.push(item);
        continue;
      }
      if (!item.audienceVotes) continue;
      for (const [localChoice, countValue] of item.audienceVotes.counts.entries()) {
        if (!Number.isFinite(countValue) || countValue <= 0) continue;
        const choice = target.choices[localChoice];
        if (choice === undefined) continue;
        const identity = {
          gameId,
          matchupId: target.matchupId,
          thriplashId: target.thriplashId,
          prompt: normalizedPrompt(item.observed.prompt),
          answers: item.observed.answers.map(normalizedText),
          choice,
        };
        await db.insert(votes).values({
          id: stableId("audience-vote", identity),
          gameId,
          matchupId: target.matchupId,
          thriplashId: target.thriplashId,
          voterId: null,
          population: "audience",
          source: "game",
          choice,
          weight: countValue,
          createdAt: eventDate(item.audienceVotes.at),
        }).onConflictDoUpdate({
          target: votes.id,
          set: { weight: countValue },
        });
      }
    }
    this.pendingObservedMatchups.set(gameId, unresolved);
  }

  private async logScoreMismatches(
    db: ArenaDatabaseClient,
    gameId: string,
    computed: Readonly<Record<string, number>>,
  ): Promise<void> {
    const players = await db.select({
      playerId: gamePlayers.playerId,
      name: gamePlayers.name,
      observedScore: gamePlayers.observedScore,
    }).from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
    for (const player of players) {
      if (player.observedScore === null) continue;
      const computedScore = computed[player.playerId];
      if (computedScore === player.observedScore) continue;
      this.logger.warn(
        `[quiparena/recorder] score mismatch game=${gameId} player=${player.name}`
        + ` computed=${computedScore ?? "missing"} observed=${player.observedScore}`,
      );
    }
  }

  private async inferTraceKind(event: TraceEvent): Promise<TraceKind> {
    const key = submissionKey(event.gameId, event.playerId, event.prompt);
    const cached = this.traceKinds.get(key);
    if (cached) return cached;

    const rows = await this.db.select({ payload: events.payload })
      .from(events)
      .where(eq(events.gameId, event.gameId))
      .orderBy(asc(events.id));
    for (const row of rows) {
      const item = row.payload;
      if (item.type === "prompt.dealt") {
        this.traceKinds.set(
          submissionKey(item.gameId, item.playerId, item.prompt),
          item.round === 3 ? "final" : "answer",
        );
      } else if (item.type === "vote.requested") {
        this.traceKinds.set(submissionKey(item.gameId, item.playerId, item.prompt), "vote");
      }
    }
    return this.traceKinds.get(key) ?? "answer";
  }

  private async recordTrace(event: TraceEvent): Promise<void> {
    await this.ensureGame(this.db, event.gameId, event.at);
    const [player] = await this.db.select({ modelSlug: gamePlayers.modelSlug })
      .from(gamePlayers)
      .where(and(eq(gamePlayers.gameId, event.gameId), eq(gamePlayers.playerId, event.playerId)))
      .limit(1);
    await this.db.insert(traces).values({
      id: stableId("trace", event),
      gameId: event.gameId,
      playerId: event.playerId,
      prompt: event.prompt,
      kind: await this.inferTraceKind(event),
      reasoning: event.reasoning,
      answer: event.answer,
      usage: traceUsage(event),
      costUsd: event.usage?.costUsd ?? null,
      modelSlug: player?.modelSlug ?? null,
      createdAt: eventDate(event.at),
    }).onConflictDoNothing({ target: traces.id });
  }
}

/** Recompute and persist all score projections for one normalized game. */
export async function finalizeGameScores(
  db: ArenaDatabaseClient,
  gameId: string,
): Promise<Record<string, number> | undefined> {
  const stored = await loadGame(db, gameId);
  if (!stored) return undefined;
  const scored = scoreGame(stored);
  for (const matchup of scored.matchups) {
    await db.update(matchups).set({ scores: matchup.scores ?? {} })
      .where(eq(matchups.id, matchup.id));
  }
  if (scored.thriplash) {
    await db.update(thriplashes).set({ scores: scored.thriplash.scores ?? {} })
      .where(eq(thriplashes.gameId, gameId));
  }

  const finalScores = scored.finalScores ?? {};
  await db.update(games).set({ finalScores }).where(eq(games.id, gameId));
  const playerRows = await db.select({ playerId: gamePlayers.playerId })
    .from(gamePlayers)
    .where(eq(gamePlayers.gameId, gameId))
    .orderBy(asc(gamePlayers.seat));
  const playerOrder = playerRows.map((player) => player.playerId);
  const placements = placementsFromScores(finalScores, playerOrder);
  for (const playerId of playerOrder) {
    await db.update(gamePlayers).set({
      placement: placements[playerId] ?? null,
      totalScore: finalScores[playerId] ?? 0,
    }).where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.playerId, playerId)));
  }
  return finalScores;
}

/** Reconstruct the shared core Game shape from normalized database rows. */
export async function loadGame(db: ArenaDatabaseClient, gameId: string): Promise<Game | undefined> {
  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  if (!game) return undefined;

  const [playerRows, matchupRows, answerRows, voteRows, thriplashRows] = await Promise.all([
    db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId)).orderBy(asc(gamePlayers.seat)),
    db.select().from(matchups).where(eq(matchups.gameId, gameId)).orderBy(asc(matchups.round), asc(matchups.index)),
    db.select().from(answers).where(eq(answers.gameId, gameId)).orderBy(asc(answers.answerIndex)),
    db.select().from(votes).where(eq(votes.gameId, gameId)).orderBy(asc(votes.createdAt), asc(votes.id)),
    db.select().from(thriplashes).where(eq(thriplashes.gameId, gameId)).limit(1),
  ]);

  const toVote = (row: (typeof voteRows)[number]): Vote => ({
    voterId: row.voterId ?? "audience",
    population: row.population,
    choice: row.choice,
    ...(row.weight === 1 ? {} : { weight: row.weight }),
  });

  const gameMatchups: Matchup[] = matchupRows.map((row) => {
    const storedAnswers = answerRows
      .filter((answer) => answer.matchupId === row.id)
      .sort((left, right) => left.answerIndex - right.answerIndex)
      .map<GameAnswer>((answer) => ({
        playerId: answer.playerId,
        text: answer.text,
        blank: answer.blank,
      }));
    if (storedAnswers.length !== 2) {
      throw new Error(`Matchup ${row.id} has ${storedAnswers.length} answers; expected 2`);
    }
    return {
      id: row.id,
      gameId: row.gameId,
      round: row.round as 1 | 2,
      index: row.index,
      prompt: row.prompt,
      answers: [storedAnswers[0]!, storedAnswers[1]!],
      votes: voteRows.filter((vote) => vote.matchupId === row.id).map(toVote),
      ...(row.scores === null ? {} : { scores: row.scores }),
    };
  });

  const storedThriplash = thriplashRows[0];
  let finalRound: Thriplash | undefined;
  if (storedThriplash) {
    finalRound = {
      gameId,
      prompt: storedThriplash.prompt,
      entries: answerRows
        .filter((answer) => answer.thriplashId === storedThriplash.id)
        .sort((left, right) => left.answerIndex - right.answerIndex)
        .map((answer) => ({
          playerId: answer.playerId,
          lines: answer.lines ?? [answer.text, "", ""],
        })),
      votes: voteRows.filter((vote) => vote.thriplashId === storedThriplash.id).map(toVote),
      ...(storedThriplash.scores === null ? {} : { scores: storedThriplash.scores }),
    };
  }

  const playerByName = new Map(playerRows.map((player) => [normalizedText(player.name), player.playerId]));
  const observedFinalScores = game.observedScores
    ? Object.fromEntries(game.observedScores.flatMap((standing) => {
        const playerId = playerByName.get(normalizedText(standing.name));
        return playerId ? [[playerId, standing.score]] : [];
      }))
    : undefined;
  const finalScores = observedFinalScores && Object.keys(observedFinalScores).length > 0
    ? { ...(game.finalScores ?? {}), ...observedFinalScores }
    : game.finalScores;
  const observedPlacements = Object.fromEntries(playerRows.flatMap((player) => (
    player.observedPlacement === null ? [] : [[player.playerId, player.observedPlacement]]
  )));

  return {
    id: game.id,
    roomCode: game.roomCode,
    startedAt: game.startedAt.toISOString(),
    ...(game.endedAt === null ? {} : { endedAt: game.endedAt.toISOString() }),
    players: playerRows.map((player) => ({
      id: player.playerId,
      name: player.name,
      modelId: player.modelSlug,
    })),
    matchups: gameMatchups,
    ...(finalRound === undefined ? {} : { thriplash: finalRound }),
    ...(finalScores === null || finalScores === undefined ? {} : { finalScores }),
    ...(Object.keys(observedPlacements).length === 0 ? {} : { observedPlacements }),
  };
}
