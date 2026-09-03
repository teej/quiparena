import type {
  GameEvent,
  Matchup,
  Thriplash,
  ThriplashEntry,
  Vote,
} from "@quiparena/core";
import { asc, eq } from "drizzle-orm";

import type { ArenaDatabaseClient } from "./db/client.js";
import { events, gamePlayers, games } from "./db/schema.js";
import { inferAudienceVote, loadGame } from "./recorder.js";
import { scoreMatchup, scoreThriplash } from "./scoring.js";

type ScoreMap = Record<string, number>;
type RoundLabel = "R1" | "R2" | "Thriplash" | "Total";

interface PromptedThriplashEntry extends ThriplashEntry {
  prompt: string;
}

interface ScoreComparison {
  computed: number;
  observed: number | null;
  delta: number | null;
}

export interface ScoringAuditPlayer {
  playerId: string;
  name: string;
  round1: ScoreComparison;
  round2: ScoreComparison;
  thriplash: ScoreComparison;
  total: ScoreComparison;
}

export interface ScoringAuditGame {
  gameId: string;
  players: ScoringAuditPlayer[];
  audienceVotes: { round1: number; round2: number; thriplash: number };
  maxFinalDelta: number | null;
}

export interface ScoringAuditSummary {
  round: RoundLabel;
  players: number;
  exact: number;
  meanDelta: number;
  meanAbsoluteDelta: number;
  maxAbsoluteDelta: number;
}

export interface ScoringAuditReport {
  games: ScoringAuditGame[];
  summary: ScoringAuditSummary[];
}

function normalizedText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function canonicalPrompt(value: string): string {
  return value.replace(/\s*vote for your favorite\s*$/i, "").trim();
}

function scoreMap(matchups: readonly Matchup[], round: 1 | 2): ScoreMap {
  const scores: ScoreMap = {};
  for (const matchup of matchups) {
    if (matchup.round !== round) continue;
    for (const [playerId, score] of Object.entries(scoreMatchup(matchup).scores ?? {})) {
      scores[playerId] = (scores[playerId] ?? 0) + score;
    }
  }
  return scores;
}

function withObservedAudienceVotes(
  matchups: readonly Matchup[],
  eventRows: readonly GameEvent[],
  playerCount: number,
): Matchup[] {
  const observed = eventRows.filter((event): event is Extract<
    GameEvent,
    { type: "matchup.observed" }
  > => event.type === "matchup.observed");
  return matchups.map((matchup) => {
    if (matchup.votes.some((vote) => vote.population === "audience")) return matchup;
    const result = observed.find((event) => (
      normalizedText(canonicalPrompt(event.prompt)) === normalizedText(canonicalPrompt(matchup.prompt))
      && event.percentages !== undefined
    ));
    if (!result?.percentages) return matchup;
    const choiceIndexes = result.answers.map((answer) => matchup.answers.findIndex((candidate) => (
      normalizedText(candidate.text) === normalizedText(answer)
    ))) as [number, number];
    if (choiceIndexes.some((choice) => choice < 0)) return matchup;
    const playerVotes = matchup.votes.filter((vote) => vote.population === "player");
    const expected = Math.max(0, playerCount - 2);
    if (playerVotes.length !== expected
      || playerVotes.some((vote) => (vote.weight ?? 1) !== 1 || !vote.voterId)) {
      return matchup;
    }
    const counts = choiceIndexes.map((choice) => playerVotes
      .filter((vote) => vote.choice === choice)
      .length) as [number, number];
    const inferred = inferAudienceVote(counts, result.percentages);
    if (!inferred) return matchup;
    return {
      ...matchup,
      votes: [
        ...matchup.votes,
        {
          voterId: "audience",
          population: "audience",
          choice: choiceIndexes[inferred.choice],
          weight: inferred.weight,
        },
      ],
    };
  });
}

function latestRoundScoreboards(eventRows: readonly GameEvent[]): Map<number, Map<string, number>> {
  const scoreboards = new Map<number, Map<string, number>>();
  for (const event of eventRows) {
    if (event.type !== "scoreboard.observed") continue;
    scoreboards.set(event.round, new Map(
      event.standings.map((standing) => [normalizedText(standing.name), standing.score]),
    ));
  }
  return scoreboards;
}

function promptedThriplash(
  stored: Thriplash,
  eventRows: readonly GameEvent[],
): Thriplash {
  const submissions = new Map<string, Extract<GameEvent, { type: "answer.submitted" }>>();
  const requests = new Map<string, Extract<GameEvent, { type: "vote.requested" }>>();
  const audienceByPrompt = new Map<string, Extract<GameEvent, { type: "audience.votes" }>>();

  for (const event of eventRows) {
    if (event.type === "answer.submitted" && event.round === 3 && Array.isArray(event.answer)) {
      submissions.set(event.playerId, event);
    } else if (event.type === "vote.requested" && event.round === 3) {
      const prompt = normalizedText(canonicalPrompt(event.prompt));
      requests.set(`${prompt}\u0000${event.playerId}`, event);
    } else if (event.type === "audience.votes") {
      audienceByPrompt.set(normalizedText(canonicalPrompt(event.prompt)), event);
    }
  }

  const entries: PromptedThriplashEntry[] = stored.entries.map((entry) => ({
    ...entry,
    prompt: canonicalPrompt(submissions.get(entry.playerId)?.prompt ?? entry.prompt ?? stored.prompt),
  }));
  const entryIndex = (promptValue: string, answer: string): number => {
    const prompt = normalizedText(canonicalPrompt(promptValue));
    const text = normalizedText(answer);
    return entries.findIndex((entry) => (
      normalizedText(entry.prompt) === prompt && normalizedText(entry.lines.join("\n")) === text
    ));
  };

  const playerVotes = new Map<string, Vote>();
  for (const event of eventRows) {
    if (event.type !== "vote.cast" || event.round !== 3) continue;
    const prompt = normalizedText(canonicalPrompt(event.prompt));
    const request = requests.get(`${prompt}\u0000${event.playerId}`);
    const answer = event.answer ?? request?.options[event.choice];
    if (!answer) continue;
    const choice = entryIndex(event.prompt, answer);
    if (choice < 0) continue;
    playerVotes.set(`${prompt}\u0000${event.playerId}`, {
      voterId: event.playerId,
      population: "player",
      choice,
    });
  }

  const audienceVotes: Vote[] = [];
  for (const [prompt, event] of audienceByPrompt) {
    const request = [...requests.entries()].find(([key]) => key.startsWith(`${prompt}\u0000`))?.[1];
    if (!request) continue;
    for (const [choiceIndex, weight] of event.counts.entries()) {
      if (!(weight > 0)) continue;
      const answer = request.options[choiceIndex];
      if (!answer) continue;
      const choice = entryIndex(event.prompt, answer);
      if (choice < 0) continue;
      audienceVotes.push({
        voterId: "audience",
        population: "audience",
        choice,
        weight,
      });
    }
  }

  const votes = playerVotes.size > 0
    ? [...playerVotes.values(), ...audienceVotes]
    : stored.votes;
  return { ...stored, entries, votes };
}

function comparison(computed: number, observed: number | undefined): ScoreComparison {
  return observed === undefined
    ? { computed, observed: null, delta: null }
    : { computed, observed, delta: computed - observed };
}

function sumAudienceVotes(matchups: readonly Matchup[], round: 1 | 2): number {
  return matchups
    .filter((matchup) => matchup.round === round)
    .flatMap((matchup) => matchup.votes)
    .filter((vote) => vote.population === "audience")
    .reduce((sum, vote) => sum + (vote.weight ?? 1), 0);
}

function summaryFor(round: RoundLabel, values: readonly ScoreComparison[]): ScoringAuditSummary {
  const deltas = values.flatMap((value) => value.delta === null ? [] : [value.delta]);
  const absolute = deltas.map(Math.abs);
  return {
    round,
    players: deltas.length,
    exact: deltas.filter((delta) => delta === 0).length,
    meanDelta: deltas.length === 0
      ? 0
      : deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length,
    meanAbsoluteDelta: absolute.length === 0
      ? 0
      : absolute.reduce((sum, delta) => sum + delta, 0) / absolute.length,
    maxAbsoluteDelta: absolute.length === 0 ? 0 : Math.max(...absolute),
  };
}

/** Compare freshly computed round points with every available observed scoreboard. */
export async function auditScoring(db: ArenaDatabaseClient): Promise<ScoringAuditReport> {
  const completed = await db.select({ id: games.id }).from(games)
    .where(eq(games.status, "completed"))
    .orderBy(asc(games.startedAt), asc(games.id));
  const auditedGames: ScoringAuditGame[] = [];

  for (const { id: gameId } of completed) {
    const [game, playerRows, storedEvents] = await Promise.all([
      loadGame(db, gameId),
      db.select({
        playerId: gamePlayers.playerId,
        name: gamePlayers.name,
        observedScore: gamePlayers.observedScore,
      }).from(gamePlayers).where(eq(gamePlayers.gameId, gameId)).orderBy(asc(gamePlayers.seat)),
      db.select({ payload: events.payload }).from(events)
        .where(eq(events.gameId, gameId)).orderBy(asc(events.id)),
    ]);
    if (!game) continue;
    const eventRows = storedEvents.map((row) => row.payload);
    const scoreboards = latestRoundScoreboards(eventRows);
    const observedRound1 = scoreboards.get(1);
    const observedRound2Cumulative = scoreboards.get(2);
    const observedFinal = { ...(game.observedScores ?? {}) };
    for (const player of playerRows) {
      if (player.observedScore !== null) observedFinal[player.playerId] = player.observedScore;
    }
    if (!observedRound1 && !observedRound2Cumulative && Object.keys(observedFinal).length === 0) {
      continue;
    }

    const auditedMatchups = withObservedAudienceVotes(game.matchups, eventRows, game.players.length);
    const round1 = scoreMap(auditedMatchups, 1);
    const round2 = scoreMap(auditedMatchups, 2);
    const finalRound = game.thriplash
      ? scoreThriplash(promptedThriplash(game.thriplash, eventRows))
      : undefined;
    const thriplash = finalRound?.scores ?? {};
    const finalAudienceVotes = finalRound?.votes
      .filter((vote) => vote.population === "audience")
      .reduce((sum, vote) => sum + (vote.weight ?? 1), 0) ?? 0;

    const players = playerRows.map((player): ScoringAuditPlayer => {
      const name = normalizedText(player.name);
      const computedRound1 = round1[player.playerId] ?? 0;
      const computedRound2 = round2[player.playerId] ?? 0;
      const computedThriplash = thriplash[player.playerId] ?? 0;
      const observed1 = observedRound1?.get(name);
      const observed2Cumulative = observedRound2Cumulative?.get(name);
      const observed2 = observed1 === undefined || observed2Cumulative === undefined
        ? undefined
        : observed2Cumulative - observed1;
      const final = observedFinal[player.playerId];
      const observedThriplash = observed2Cumulative === undefined || final === undefined
        ? undefined
        : final - observed2Cumulative;
      const computedTotal = computedRound1 + computedRound2 + computedThriplash;
      return {
        playerId: player.playerId,
        name: player.name,
        round1: comparison(computedRound1, observed1),
        round2: comparison(computedRound2, observed2),
        thriplash: comparison(computedThriplash, observedThriplash),
        total: comparison(computedTotal, final),
      };
    });
    const finalDeltas = players.flatMap((player) => (
      player.total.delta === null ? [] : [Math.abs(player.total.delta)]
    ));
    auditedGames.push({
      gameId,
      players,
      audienceVotes: {
        round1: sumAudienceVotes(auditedMatchups, 1),
        round2: sumAudienceVotes(auditedMatchups, 2),
        thriplash: finalAudienceVotes,
      },
      maxFinalDelta: finalDeltas.length === 0 ? null : Math.max(...finalDeltas),
    });
  }

  return {
    games: auditedGames,
    summary: [
      summaryFor("R1", auditedGames.flatMap((game) => game.players.map((player) => player.round1))),
      summaryFor("R2", auditedGames.flatMap((game) => game.players.map((player) => player.round2))),
      summaryFor(
        "Thriplash",
        auditedGames.flatMap((game) => game.players.map((player) => player.thriplash)),
      ),
      summaryFor("Total", auditedGames.flatMap((game) => game.players.map((player) => player.total))),
    ],
  };
}

function displayed(value: number | null): string {
  if (value === null) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function signed(value: number | null): string {
  if (value === null) return "-";
  return value > 0 ? `+${displayed(value)}` : displayed(value);
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => row[index]?.length ?? 0),
  ));
  const line = (row: readonly string[]): string => row
    .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
    .join("  ")
    .trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

/** Human-readable CLI report. */
export function formatScoringAudit(report: ScoringAuditReport): string {
  const output: string[] = [];
  for (const game of report.games) {
    output.push(
      `Game ${game.gameId} (audience units: R1=${game.audienceVotes.round1},`
      + ` R2=${game.audienceVotes.round2}, Thriplash=${game.audienceVotes.thriplash})`,
    );
    output.push(table(
      [
        "Player",
        "R1 cmp/obs/Δ",
        "R2 cmp/obs/Δ",
        "Thr cmp/obs/Δ",
        "Total cmp/obs/Δ",
      ],
      game.players.map((player) => [
        player.name,
        `${displayed(player.round1.computed)}/${displayed(player.round1.observed)}/${signed(player.round1.delta)}`,
        `${displayed(player.round2.computed)}/${displayed(player.round2.observed)}/${signed(player.round2.delta)}`,
        `${displayed(player.thriplash.computed)}/${displayed(player.thriplash.observed)}/${signed(player.thriplash.delta)}`,
        `${displayed(player.total.computed)}/${displayed(player.total.observed)}/${signed(player.total.delta)}`,
      ]),
    ));
    output.push("");
  }
  output.push("Summary (delta = computed - observed)");
  output.push(table(
    ["Round", "Players", "Exact", "Mean Δ", "Mean |Δ|", "Max |Δ|"],
    report.summary.map((row) => [
      row.round,
      String(row.players),
      String(row.exact),
      signed(row.meanDelta),
      displayed(row.meanAbsoluteDelta),
      displayed(row.maxAbsoluteDelta),
    ]),
  ));
  return output.join("\n");
}
