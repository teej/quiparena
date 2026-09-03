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

interface ObservedTarget {
  matchupId: string | null;
  thriplashId: string | null;
  /** Map audience presentation order to normalized answer indexes. */
  choices: [number, number];
}

export interface InferredAudienceVote {
  choice: 0 | 1;
  weight: number;
  totalVotes: number;
}

export interface AudienceBackfillResult {
  observedMatchups: number;
  inferredVotes: number;
  countedVotes: number;
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

const MAX_INFERRED_AUDIENCE_UNITS = 100;

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

function decimalPlaces(value: number): number {
  const text = String(value).toLocaleLowerCase("en-US");
  if (text.includes("e-")) {
    const [coefficient, exponentText] = text.split("e-");
    return (coefficient?.split(".")[1]?.length ?? 0) + Number(exponentText ?? 0);
  }
  return text.split(".")[1]?.length ?? 0;
}

function roundedPercentageMatches(count: number, total: number, observed: number): boolean {
  const places = decimalPlaces(observed);
  const scale = 10 ** places;
  const rounded = Math.round((100 * count / total + Number.EPSILON) * scale) / scale;
  return Math.abs(rounded - observed) < 1e-9;
}

function percentagesMatch(
  counts: readonly [number, number],
  total: number,
  observed: readonly [number, number],
): boolean {
  return roundedPercentageMatches(counts[0], total, observed[0])
    && roundedPercentageMatches(counts[1], total, observed[1]);
}

/**
 * Recover Quiplash's aggregate audience contribution from rounded result shares.
 * The smallest total consistent with the narration wins, while a player-only
 * explanation always suppresses inference.
 */
export function inferAudienceVote(
  playerCounts: readonly [number, number],
  observedPercentages: readonly [number, number],
): InferredAudienceVote | undefined {
  if (playerCounts.some((count) => !Number.isInteger(count) || count < 0)) return undefined;
  if (observedPercentages.some((percent) => !Number.isFinite(percent) || percent < 0 || percent > 100)) {
    return undefined;
  }
  const playerTotal = playerCounts[0] + playerCounts[1];
  if (playerTotal <= 0) return undefined;
  if (percentagesMatch(playerCounts, playerTotal, observedPercentages)) return undefined;

  const playerShares: [number, number] = [
    100 * playerCounts[0] / playerTotal,
    100 * playerCounts[1] / playerTotal,
  ];
  const deltas: [number, number] = [
    observedPercentages[0] - playerShares[0],
    observedPercentages[1] - playerShares[1],
  ];
  const audienceChoice = deltas[0] > 1e-9 && deltas[0] > deltas[1]
    ? 0
    : deltas[1] > 1e-9 && deltas[1] > deltas[0]
      ? 1
      : undefined;
  if (audienceChoice === undefined) return undefined;

  for (let weight = 1; weight <= MAX_INFERRED_AUDIENCE_UNITS; weight += 1) {
    const combined: [number, number] = [...playerCounts];
    combined[audienceChoice] += weight;
    const totalVotes = playerTotal + weight;
    if (percentagesMatch(combined, totalVotes, observedPercentages)) {
      return { choice: audienceChoice, weight, totalVotes };
    }
  }
  return undefined;
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

function observedTargetFromRows(
  observed: MatchupObservedEvent,
  matchupRows: readonly (typeof matchups.$inferSelect)[],
  answerRows: readonly (typeof answers.$inferSelect)[],
  thriplashRows: readonly (typeof thriplashes.$inferSelect)[],
): ObservedTarget | undefined {
  for (const matchup of matchupRows) {
    if (normalizedPrompt(matchup.prompt) !== normalizedPrompt(observed.prompt)) continue;
    const storedAnswers = answerRows.filter((answer) => answer.matchupId === matchup.id);
    const choices = matchedAnswerIndexes(observed.answers, storedAnswers);
    if (choices) return { matchupId: matchup.id, thriplashId: null, choices };
  }

  const thriplash = thriplashRows[0];
  if (thriplash && normalizedPrompt(thriplash.prompt) === normalizedPrompt(observed.prompt)) {
    const storedAnswers = answerRows.filter((answer) => answer.thriplashId === thriplash.id);
    const choices = matchedAnswerIndexes(observed.answers, storedAnswers);
    if (choices) return { matchupId: null, thriplashId: thriplash.id, choices };
  }
  return undefined;
}

async function resolveObservedTarget(
  db: ArenaDatabaseClient,
  observed: MatchupObservedEvent,
): Promise<ObservedTarget | undefined> {
  const [matchupRows, answerRows, thriplashRows] = await Promise.all([
    db.select().from(matchups).where(eq(matchups.gameId, observed.gameId)),
    db.select().from(answers).where(eq(answers.gameId, observed.gameId)),
    db.select().from(thriplashes).where(eq(thriplashes.gameId, observed.gameId)).limit(1),
  ]);
  return observedTargetFromRows(observed, matchupRows, answerRows, thriplashRows);
}

function targetCondition(target: ObservedTarget) {
  if (target.matchupId !== null) return eq(votes.matchupId, target.matchupId);
  if (target.thriplashId !== null) return eq(votes.thriplashId, target.thriplashId);
  throw new Error("An observed audience vote target must identify a matchup or Thriplash");
}

function audienceVoteId(gameId: string, target: ObservedTarget, choice: number): string {
  return stableId("audience-vote", {
    gameId,
    matchupId: target.matchupId,
    thriplashId: target.thriplashId,
    choice,
  });
}

async function reconcileObservedAudienceVote(
  db: ArenaDatabaseClient,
  observed: MatchupObservedEvent,
  audienceVotes: AudienceVotesEvent | undefined,
  target: ObservedTarget,
): Promise<"counted" | "inferred" | "none"> {
  const directCounts = audienceVotes?.counts.slice(0, 2);
  const hasValidDirectCounts = directCounts?.length === 2
    && directCounts.every((count) => Number.isFinite(count) && count >= 0);
  if (audienceVotes && hasValidDirectCounts && directCounts.some((count) => count > 0)) {
    await db.delete(votes).where(and(
      targetCondition(target),
      eq(votes.population, "audience"),
      eq(votes.source, "game"),
    ));
    for (const [localChoice, weight] of directCounts.entries()) {
      if (weight <= 0) continue;
      const choice = target.choices[localChoice];
      if (choice === undefined) continue;
      await db.insert(votes).values({
        id: audienceVoteId(observed.gameId, target, choice),
        gameId: observed.gameId,
        matchupId: target.matchupId,
        thriplashId: target.thriplashId,
        voterId: null,
        population: "audience",
        source: "game",
        choice,
        weight,
        inferred: false,
        createdAt: eventDate(audienceVotes.at),
      });
    }
    return "counted";
  }

  // A nonzero fetched/count-group row is authoritative for this target.
  const countedRows = await db.select({ id: votes.id }).from(votes).where(and(
    targetCondition(target),
    eq(votes.population, "audience"),
    eq(votes.source, "game"),
    eq(votes.inferred, false),
  )).limit(1);
  if (countedRows.length > 0) return "counted";

  // The current inference contract is only valid for normal two-author
  // matchups, where all other occupied seats vote.
  if (target.matchupId === null || !observed.percentages) return "none";
  const [players, playerVoteRows] = await Promise.all([
    db.select({ playerId: gamePlayers.playerId }).from(gamePlayers)
      .where(eq(gamePlayers.gameId, observed.gameId)),
    db.select({ choice: votes.choice, weight: votes.weight, voterId: votes.voterId }).from(votes)
      .where(and(eq(votes.matchupId, target.matchupId), eq(votes.population, "player"))),
  ]);
  const expectedPlayerVotes = Math.max(0, players.length - 2);
  const completePlayerVotes = expectedPlayerVotes > 0
    && playerVoteRows.length === expectedPlayerVotes
    && playerVoteRows.every((vote) => vote.voterId !== null && vote.weight === 1);
  if (!completePlayerVotes) return "none";

  const playerCounts = target.choices.map((choice) => playerVoteRows
    .filter((vote) => vote.choice === choice)
    .reduce((sum, vote) => sum + vote.weight, 0)) as [number, number];
  if (playerCounts[0] + playerCounts[1] !== expectedPlayerVotes) return "none";
  const inferred = inferAudienceVote(playerCounts, observed.percentages);

  await db.delete(votes).where(and(
    targetCondition(target),
    eq(votes.population, "audience"),
    eq(votes.source, "game"),
    eq(votes.inferred, true),
  ));
  if (!inferred) return "none";

  const choice = target.choices[inferred.choice];
  await db.insert(votes).values({
    id: audienceVoteId(observed.gameId, target, choice),
    gameId: observed.gameId,
    matchupId: target.matchupId,
    thriplashId: null,
    voterId: null,
    population: "audience",
    source: "game",
    choice,
    weight: inferred.weight,
    inferred: true,
    createdAt: eventDate(observed.at),
  }).onConflictDoUpdate({
    target: votes.id,
    set: {
      choice,
      weight: inferred.weight,
      inferred: true,
      createdAt: eventDate(observed.at),
    },
  });
  return "inferred";
}

function modelLab(slug: string): string {
  return slug.split("/", 1)[0]?.trim() || "unknown";
}

function hasGameId(event: GameEvent): event is GameEvent & { gameId: string } {
  return "gameId" in event && typeof event.gameId === "string";
}

function traceUsage(event: TraceEvent): Record<string, unknown> | null {
  if (!event.usage && !event.attempts) return null;
  return {
    ...(event.usage ?? {}),
    ...(event.attempts === undefined ? {} : { attempts: event.attempts }),
  };
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
        inferred: false,
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
      const target = observedTargetFromRows(item.observed, matchupRows, answerRows, thriplashRows);
      if (!target) {
        unresolved.push(item);
        continue;
      }
      await reconcileObservedAudienceVote(db, item.observed, item.audienceVotes, target);
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

/** Re-run audience result reconciliation from the immutable stored event stream. */
export async function backfillAudienceVotes(
  db: ArenaDatabaseClient,
): Promise<AudienceBackfillResult> {
  const eventRows = await db.select({ payload: events.payload }).from(events).orderBy(asc(events.id));
  const latestCounts = new Map<string, AudienceVotesEvent>();
  const affectedGames = new Set<string>();
  const result: AudienceBackfillResult = {
    observedMatchups: 0,
    inferredVotes: 0,
    countedVotes: 0,
  };

  for (const { payload } of eventRows) {
    if (payload.type === "audience.votes") {
      latestCounts.set(
        canonical([payload.gameId, normalizedPrompt(payload.prompt)]),
        payload,
      );
      continue;
    }
    if (payload.type !== "matchup.observed" || !payload.percentages) continue;
    result.observedMatchups += 1;
    const key = canonical([payload.gameId, normalizedPrompt(payload.prompt)]);
    const audienceVotes = latestCounts.get(key);
    latestCounts.delete(key);
    const target = await resolveObservedTarget(db, payload);
    if (!target) continue;
    const outcome = await reconcileObservedAudienceVote(db, payload, audienceVotes, target);
    if (outcome === "inferred") result.inferredVotes += 1;
    if (outcome === "counted") result.countedVotes += 1;
    if (outcome !== "none") affectedGames.add(payload.gameId);
  }

  for (const gameId of affectedGames) await finalizeGameScores(db, gameId);
  return result;
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
    ? observedFinalScores
    : undefined;
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
    ...(game.finalScores === null ? {} : { finalScores: game.finalScores }),
    ...(finalScores === undefined ? {} : { observedScores: finalScores }),
    ...(Object.keys(observedPlacements).length === 0 ? {} : { observedPlacements }),
  };
}
