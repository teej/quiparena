import { and, eq, inArray } from "drizzle-orm";
import type { Matchup, PlayerRef, VotePopulation } from "@quiparena/core";
import {
  gameAnalytics,
  games as gamesTable,
  answers,
  currentSeasonGameIds,
  gamePlayers,
  hasAudienceVotes,
  leaderboard as loadLeaderboard,
  traces,
  votes,
  type ArenaDatabaseClient,
} from "@quiparena/arena";

import type { FrontierEntry, FrontierResponse } from "../shared/frontier.js";
import type { AnswerTrace, LeaderboardEntry, LeaderboardPopulation } from "../shared/types.js";
import { frontierCost } from "./frontier-cost.js";

/** Rating-side inputs, one per model, already scoped to the requested population. */
export interface FrontierModelRow {
  slug: string;
  displayName: string;
  lab: string;
  rating: number;
  plusMinus: number;
  games: number;
}

export type FrontierTraceKind = "answer" | "final" | "vote";

export interface FrontierTraceRow {
  modelSlug: string;
  kind: FrontierTraceKind;
  costUsd: number | null;
  totalMs: number | null;
  reasoningTokens: number | null;
}

export interface FrontierMatchupRow {
  /** Model slugs of answers 0 and 1. */
  slugs: [string, string];
  votes: ReadonlyArray<{ choice: number; population: VotePopulation; weight: number }>;
}

interface Accumulator {
  answers: number;
  cost: number;
  /** Traces whose provider reported a price. Zero means cost is unknown, not free. */
  priced: number;
  answerMs: number[];
  answerReasoning: number[];
  wins: number;
  played: number;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Wall time of the call: `usage.totalMs`, else the sum of the recorded attempts. */
function answerMs(usage: Record<string, unknown> | null | undefined, attempts?: unknown): number | null {
  const total = asNumber(usage?.["totalMs"]);
  if (total !== null) return total;
  const list = attempts ?? usage?.["attempts"];
  if (!Array.isArray(list) || list.length === 0) return null;
  const sum = list.reduce<number>((acc, attempt) => acc + (asNumber((attempt as { ms?: unknown })?.ms) ?? 0), 0);
  return sum > 0 ? sum : null;
}

/** Fold traces and matchup outcomes onto the rated model rows. Pure; shared by both stores. */
export function buildFrontier(
  population: LeaderboardPopulation,
  models: readonly FrontierModelRow[],
  traceRows: readonly FrontierTraceRow[],
  matchupRows: readonly FrontierMatchupRow[],
): FrontierEntry[] {
  const totals = new Map<string, Accumulator>();
  const bucket = (slug: string): Accumulator => {
    let entry = totals.get(slug);
    if (!entry) {
      entry = { answers: 0, cost: 0, priced: 0, answerMs: [], answerReasoning: [], wins: 0, played: 0 };
      totals.set(slug, entry);
    }
    return entry;
  };

  for (const trace of traceRows) {
    const entry = bucket(trace.modelSlug);
    if (trace.costUsd !== null && trace.costUsd > 0) {
      entry.cost += trace.costUsd;
      entry.priced += 1;
    }
    if (trace.kind !== "answer") continue;
    entry.answers += 1;
    if (trace.totalMs !== null) entry.answerMs.push(trace.totalMs);
    if (trace.reasoningTokens !== null) entry.answerReasoning.push(trace.reasoningTokens);
  }

  for (const matchup of matchupRows) {
    const [left, right] = matchup.slugs;
    if (left === right) continue;
    let leftVotes = 0;
    let rightVotes = 0;
    for (const vote of matchup.votes) {
      if (population !== "blended" && vote.population !== population) continue;
      if (!(vote.weight > 0)) continue;
      if (vote.choice === 0) leftVotes += vote.weight;
      else if (vote.choice === 1) rightVotes += vote.weight;
    }
    if (leftVotes + rightVotes === 0) continue;
    bucket(left).played += 1;
    bucket(right).played += 1;
    if (leftVotes > rightVotes) bucket(left).wins += 1;
    if (rightVotes > leftVotes) bucket(right).wins += 1;
  }

  return models.map((model): FrontierEntry => {
    const entry = totals.get(model.slug) ?? bucket(model.slug);
    return {
      slug: model.slug,
      displayName: model.displayName,
      lab: model.lab,
      rating: model.rating,
      plusMinus: model.plusMinus,
      games: model.games,
      answers: entry.answers,
      matchupWins: entry.wins,
      matchupsPlayed: entry.played,
      totalCostUsd: entry.cost,
      costPerAnswerUsd: entry.priced === 0 || entry.answers === 0 ? null : entry.cost / entry.answers,
      costPerWinUsd: entry.priced === 0 || entry.wins === 0 ? null : entry.cost / entry.wins,
      avgAnswerMs: mean(entry.answerMs),
      reasoningTokensPerAnswer: mean(entry.answerReasoning),
    };
  }).sort((left, right) => right.rating - left.rating || left.displayName.localeCompare(right.displayName));
}

export function leaderboardModelRow(entry: LeaderboardEntry): FrontierModelRow {
  return {
    slug: entry.modelId,
    displayName: entry.name,
    lab: entry.lab,
    rating: entry.rating,
    plusMinus: Math.round(Math.max(entry.rating - entry.intervalLow, entry.intervalHigh - entry.rating)),
    games: entry.games,
  };
}

/** Frontier over archived games held in memory. Trace kind is inferred from the prompt. */
export function inMemoryFrontier(
  population: LeaderboardPopulation,
  board: readonly LeaderboardEntry[],
  games: ReadonlyArray<{ players: PlayerRef[]; matchups: Matchup[]; thriplash?: { prompt: string } | null }>,
  tracesByGame: ReadonlyArray<Record<string, AnswerTrace[]>>,
): FrontierEntry[] {
  const traceRows: FrontierTraceRow[] = [];
  const matchupRows: FrontierMatchupRow[] = [];
  games.forEach((game, index) => {
    const slugByPlayer = new Map(game.players.flatMap((player) => (
      player.modelId ? [[player.id, player.modelId] as const] : []
    )));
    const authored = new Set<string>();
    for (const matchup of game.matchups) {
      for (const answer of matchup.answers) authored.add(`${answer.playerId}\u0000${matchup.prompt}`);
      const left = slugByPlayer.get(matchup.answers[0].playerId);
      const right = slugByPlayer.get(matchup.answers[1].playerId);
      if (!left || !right) continue;
      matchupRows.push({
        slugs: [left, right],
        votes: matchup.votes.map((vote) => ({
          choice: vote.choice,
          population: vote.population,
          weight: vote.weight ?? 1,
        })),
      });
    }
    for (const trace of Object.values(tracesByGame[index] ?? {}).flat()) {
      const modelSlug = slugByPlayer.get(trace.playerId);
      if (!modelSlug) continue;
      const kind: FrontierTraceKind = authored.has(`${trace.playerId}\u0000${trace.prompt}`)
        ? "answer"
        : game.thriplash?.prompt === trace.prompt ? "final" : "vote";
      traceRows.push({
        modelSlug,
        kind,
        costUsd: frontierCost(modelSlug, asNumber(trace.usage?.costUsd), trace.at),
        totalMs: answerMs(trace.usage, trace.attempts),
        reasoningTokens: asNumber(trace.usage?.reasoningTokens),
      });
    }
  });
  return buildFrontier(population, board.map(leaderboardModelRow), traceRows, matchupRows);
}

/** Frontier over the normalized database: enabled models joined to their traces and matchup votes. */
async function summarizeGame(db: ArenaDatabaseClient, gameId: string): Promise<GameTotals[]> {
  const seasonGames = new Set([gameId]);
  const [traceRows, playerRows, answerRows, voteRows] = await Promise.all([
    db.select({
      gameId: traces.gameId,
      modelSlug: traces.modelSlug,
      kind: traces.kind,
      costUsd: traces.costUsd,
      createdAt: traces.createdAt,
      usage: traces.usage,
    }).from(traces).where(eq(traces.gameId, gameId)),
    db.select({
      gameId: gamePlayers.gameId,
      playerId: gamePlayers.playerId,
      modelSlug: gamePlayers.modelSlug,
    }).from(gamePlayers).where(eq(gamePlayers.gameId, gameId)),
    db.select({
      gameId: answers.gameId,
      playerId: answers.playerId,
      matchupId: answers.matchupId,
      answerIndex: answers.answerIndex,
    }).from(answers).where(eq(answers.gameId, gameId)),
    db.select({
      matchupId: votes.matchupId,
      choice: votes.choice,
      population: votes.population,
      weight: votes.weight,
    }).from(votes).where(eq(votes.gameId, gameId)),
  ]);

  const slugByPlayer = new Map<string, string>();
  for (const player of playerRows) {
    if (player.modelSlug) slugByPlayer.set(`${player.gameId}\u0000${player.playerId}`, player.modelSlug);
  }
  const slugsByMatchup = new Map<string, Map<number, string>>();
  for (const answer of answerRows) {
    if (!answer.matchupId || !seasonGames.has(answer.gameId)) continue;
    const slug = slugByPlayer.get(`${answer.gameId}\u0000${answer.playerId}`);
    if (!slug) continue;
    const slots = slugsByMatchup.get(answer.matchupId) ?? new Map<number, string>();
    slots.set(answer.answerIndex, slug);
    slugsByMatchup.set(answer.matchupId, slots);
  }
  const votesByMatchup = new Map<string, FrontierMatchupRow["votes"][number][]>();
  for (const vote of voteRows) {
    if (!vote.matchupId) continue;
    const list = votesByMatchup.get(vote.matchupId) ?? [];
    list.push({ choice: vote.choice, population: vote.population, weight: vote.weight });
    votesByMatchup.set(vote.matchupId, list);
  }
  const matchupRows: FrontierMatchupRow[] = [];
  for (const [matchupId, slots] of slugsByMatchup) {
    const left = slots.get(0);
    const right = slots.get(1);
    if (!left || !right) continue;
    matchupRows.push({ slugs: [left, right], votes: votesByMatchup.get(matchupId) ?? [] });
  }

  const traceInputs = traceRows.flatMap((row): FrontierTraceRow[] => row.modelSlug && seasonGames.has(row.gameId) ? [{
    modelSlug: row.modelSlug,
    kind: row.kind,
    costUsd: frontierCost(row.modelSlug, row.costUsd, row.createdAt),
    totalMs: answerMs(row.usage),
    reasoningTokens: asNumber(row.usage?.["reasoningTokens"]),
  }] : []);

  const models = [...new Set(playerRows.flatMap(row => row.modelSlug ? [row.modelSlug] : []))]
    .map(slug => ({ slug, displayName: slug, lab: "", rating: 0, plusMinus: 0, games: 0 }));
  const outcomes = Object.fromEntries((["player", "audience", "blended"] as const)
    .map(pop => [pop, buildFrontier(pop, models, traceInputs, matchupRows)]));
  return models.map(model => {
    const inputs = traceInputs.filter(row => row.modelSlug === model.slug);
    const normal = inputs.filter(row => row.kind === "answer");
    const ms = normal.flatMap(row => row.totalMs === null ? [] : [row.totalMs]);
    const reasoning = normal.flatMap(row => row.reasoningTokens === null ? [] : [row.reasoningTokens]);
    return {
      slug: model.slug,
      cost: inputs.reduce((sum, row) => sum + Math.max(0, row.costUsd ?? 0), 0),
      priced: inputs.filter(row => row.costUsd !== null && row.costUsd > 0).length,
      answers: normal.length,
      msSum: ms.reduce((a, b) => a + b, 0), msCount: ms.length,
      reasoningSum: reasoning.reduce((a, b) => a + b, 0), reasoningCount: reasoning.length,
      outcomes: Object.fromEntries((["player", "audience", "blended"] as const).map(pop => {
        const entry = outcomes[pop]!.find(row => row.slug === model.slug)!;
        return [pop, { wins: entry.matchupWins, played: entry.matchupsPlayed }];
      })) as GameTotals["outcomes"],
    };
  });
}

interface GameTotals {
  slug: string;
  cost: number;
  priced: number;
  answers: number;
  msSum: number;
  msCount: number;
  reasoningSum: number;
  reasoningCount: number;
  outcomes: Record<LeaderboardPopulation, { wins: number; played: number }>;
}
const AGGREGATE_VERSION = 2;

/** Closed games are summarized once. A version bump explicitly rebuilds derived data. */
export async function refreshGameAnalytics(db: ArenaDatabaseClient): Promise<void> {
  const rows = await db.select({ id: gamesTable.id, version: gameAnalytics.version })
    .from(gamesTable).leftJoin(gameAnalytics, eq(gamesTable.id, gameAnalytics.gameId))
    .where(inArray(gamesTable.status, ["completed", "abandoned", "failed"]));
  for (const row of rows) {
    if (row.version === AGGREGATE_VERSION) continue;
    const totals = await summarizeGame(db, row.id);
    await db.insert(gameAnalytics).values({ gameId: row.id, version: AGGREGATE_VERSION, totals })
      .onConflictDoUpdate({ target: gameAnalytics.gameId, set: { version: AGGREGATE_VERSION, totals } });
  }
}

/** Requests read compact closed-game totals, never historical traces or vote rows. */
export async function loadDbFrontier(db: ArenaDatabaseClient, population: LeaderboardPopulation): Promise<FrontierResponse> {
  const [seasonGames, board, audienceVotingAvailable] = await Promise.all([
    currentSeasonGameIds(db), loadLeaderboard(db, population), hasAudienceVotes(db),
  ]);
  if (population === "audience" && !audienceVotingAvailable) return { population, audienceVotingAvailable, entries: [] };
  const rows = seasonGames.size === 0 ? [] : await db.select({ totals: gameAnalytics.totals }).from(gameAnalytics)
    .where(and(eq(gameAnalytics.version, AGGREGATE_VERSION), inArray(gameAnalytics.gameId, [...seasonGames])));
  const totals = new Map<string, GameTotals>();
  for (const row of rows) for (const entry of row.totals as GameTotals[]) {
    const sum = totals.get(entry.slug);
    if (!sum) { totals.set(entry.slug, structuredClone(entry)); continue; }
    for (const key of ["cost", "priced", "answers", "msSum", "msCount", "reasoningSum", "reasoningCount"] as const) sum[key] += entry[key];
    for (const pop of ["player", "audience", "blended"] as const) {
      sum.outcomes[pop].wins += entry.outcomes[pop].wins;
      sum.outcomes[pop].played += entry.outcomes[pop].played;
    }
  }
  const entries = board.filter(row => row.enabled).map((model): FrontierEntry => {
    const t = totals.get(model.modelSlug);
    const wins = t?.outcomes[population].wins ?? 0;
    const count = t?.answers ?? 0;
    return {
      slug: model.modelSlug, displayName: model.displayName, lab: model.lab,
      rating: Math.round(model.rating),
      plusMinus: Math.round(Math.max(model.rating - model.lower95, model.upper95 - model.rating)),
      games: model.stats.games, answers: count, matchupWins: wins,
      matchupsPlayed: t?.outcomes[population].played ?? 0,
      totalCostUsd: t?.cost ?? 0,
      costPerAnswerUsd: t?.priced && count ? t.cost / count : null,
      costPerWinUsd: t?.priced && wins ? t.cost / wins : null,
      avgAnswerMs: t?.msCount ? t.msSum / t.msCount : null,
      reasoningTokensPerAnswer: t?.reasoningCount ? t.reasoningSum / t.reasoningCount : null,
    };
  });
  return { population, audienceVotingAvailable, entries };
}
