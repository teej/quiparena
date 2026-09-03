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
type TraceKind = "answer" | "final" | "vote";

interface SubmissionMeta {
  blank: boolean;
  latencyMs: number;
}

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

  constructor(readonly db: ArenaDatabaseClient) {}

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
        break;

      case "thriplash.resolved":
        await this.recordThriplash(db, event.thriplash, event.at);
        break;

      case "game.ended":
        await db.update(games).set({
          endedAt: eventDate(event.at),
          status: "completed",
          finalScores: event.finalScores ?? null,
        }).where(eq(games.id, event.gameId));
        if (event.finalScores) await this.recordPlacements(db, event.gameId, event.finalScores);
        break;

      case "round.started":
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

  private async recordPlacements(
    db: ArenaDatabaseClient,
    gameId: string,
    finalScores: Record<string, number>,
  ): Promise<void> {
    const ordered = Object.entries(finalScores).sort((left, right) => right[1] - left[1]);
    for (const [index, [playerId, totalScore]] of ordered.entries()) {
      await db.update(gamePlayers).set({
        placement: index + 1,
        totalScore,
      }).where(and(eq(gamePlayers.gameId, gameId), eq(gamePlayers.playerId, playerId)));
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
  };
}
