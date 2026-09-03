import { desc, eq } from "drizzle-orm";

import type { ArenaDatabaseClient } from "./db/client.js";
import { abandonStaleGames, backfillCompletedGameScores } from "./db/operations.js";
import {
  answers,
  gamePlayers,
  games,
  models,
  ratingSnapshots,
  votes,
} from "./db/schema.js";

export type RatingPopulation = "player" | "audience" | "blended";

export interface Comparison {
  winner: string;
  loser: string;
  population: "player" | "audience";
  weight: number;
}

export interface BradleyTerryOptions {
  ridge?: number;
  tolerance?: number;
  maxIterations?: number;
  bootstrapResamples?: number;
  blendedWeights?: { player: number; audience: number };
  rng?: () => number;
}

export interface ModelStats {
  games: number;
  wins: number;
  avgPlacement: number | null;
  matchupWinRate: number | null;
  avgPoints: number | null;
}

export interface RatingEntry {
  modelSlug: string;
  rating: number;
  lower95: number;
  upper95: number;
  strength: number;
  comparisons: number;
  stats: ModelStats;
}

export interface RatingRun {
  computedAt: string;
  method: string;
  populations: Record<RatingPopulation, RatingEntry[]>;
}

export interface LeaderboardEntry extends RatingEntry {
  displayName: string;
  lab: string;
  enabled: boolean;
  benched: boolean;
  benchReason: string | null;
  population: RatingPopulation;
  computedAt: string;
}

export interface ComputeRatingsOptions extends BradleyTerryOptions {
  now?: Date;
}

const METHOD = "bradley-terry-mm-ridge-elo-v1";
const DEFAULT_RIDGE = 0.5;
const DEFAULT_TOLERANCE = 1e-9;
const DEFAULT_MAX_ITERATIONS = 1_000;
const DEFAULT_BOOTSTRAPS = 200;

interface PointEstimate {
  strength: number;
  rating: number;
  comparisons: number;
}

function validatedOptions(options: BradleyTerryOptions): Required<Omit<BradleyTerryOptions, "rng">> {
  const ridge = options.ridge ?? DEFAULT_RIDGE;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const bootstrapResamples = options.bootstrapResamples ?? DEFAULT_BOOTSTRAPS;
  const blendedWeights = options.blendedWeights ?? { player: 1, audience: 1 };
  if (!Number.isFinite(ridge) || ridge <= 0) throw new RangeError("ridge must be positive");
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError("tolerance must be positive");
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError("maxIterations must be a positive integer");
  }
  if (!Number.isInteger(bootstrapResamples) || bootstrapResamples < 0) {
    throw new RangeError("bootstrapResamples must be a non-negative integer");
  }
  if (!Number.isFinite(blendedWeights.player) || blendedWeights.player < 0
    || !Number.isFinite(blendedWeights.audience) || blendedWeights.audience < 0
    || blendedWeights.player + blendedWeights.audience <= 0) {
    throw new RangeError("blended population weights must be non-negative and not both zero");
  }
  return { ridge, tolerance, maxIterations, bootstrapResamples, blendedWeights };
}

function weightedForPopulation(
  comparisons: readonly Comparison[],
  population: RatingPopulation,
  blendedWeights: { player: number; audience: number },
): Comparison[] {
  if (population !== "blended") {
    return comparisons.filter((comparison) => comparison.population === population);
  }
  return comparisons
    .map((comparison) => ({
      ...comparison,
      weight: comparison.weight * blendedWeights[comparison.population],
    }))
    .filter((comparison) => comparison.weight > 0);
}

/** Fixed-point/MM solution of ridge-regularized Bradley-Terry strengths. */
function fitPoint(
  modelSlugs: readonly string[],
  comparisons: readonly Comparison[],
  options: Pick<Required<BradleyTerryOptions>, "ridge" | "tolerance" | "maxIterations">,
): Map<string, PointEstimate> {
  const indexBySlug = new Map(modelSlugs.map((slug, index) => [slug, index]));
  let strengths = new Float64Array(modelSlugs.length).fill(1);
  const valid = comparisons.filter((comparison) => (
    comparison.winner !== comparison.loser
    && indexBySlug.has(comparison.winner)
    && indexBySlug.has(comparison.loser)
    && Number.isFinite(comparison.weight)
    && comparison.weight > 0
  ));
  const comparisonWeights = new Float64Array(modelSlugs.length);

  for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
    const wins = new Float64Array(modelSlugs.length);
    const denominator = new Float64Array(modelSlugs.length);
    comparisonWeights.fill(0);
    for (const comparison of valid) {
      const winner = indexBySlug.get(comparison.winner)!;
      const loser = indexBySlug.get(comparison.loser)!;
      const sum = strengths[winner]! + strengths[loser]!;
      wins[winner] = wins[winner]! + comparison.weight;
      denominator[winner] = denominator[winner]! + comparison.weight / sum;
      denominator[loser] = denominator[loser]! + comparison.weight / sum;
      comparisonWeights[winner] = comparisonWeights[winner]! + comparison.weight;
      comparisonWeights[loser] = comparisonWeights[loser]! + comparison.weight;
    }

    const next = new Float64Array(modelSlugs.length);
    for (let index = 0; index < modelSlugs.length; index += 1) {
      // A symmetric pseudo-match against a unit-strength anchor is the ridge prior.
      const priorDenominator = (2 * options.ridge) / (strengths[index]! + 1);
      next[index] = Math.max(
        1e-12,
        (wins[index]! + options.ridge) / (denominator[index]! + priorDenominator),
      );
    }
    const logMean = next.length === 0
      ? 0
      : Array.from(next).reduce((sum, strength) => sum + Math.log(strength), 0) / next.length;
    const scale = Math.exp(logMean);
    let delta = 0;
    for (let index = 0; index < next.length; index += 1) {
      next[index] = next[index]! / scale;
      delta = Math.max(delta, Math.abs(Math.log(next[index]! / strengths[index]!)));
    }
    strengths = next;
    if (delta < options.tolerance) break;
  }

  return new Map(modelSlugs.map((slug, index) => {
    const strength = strengths[index] ?? 1;
    return [slug, {
      strength,
      rating: 1_000 + 400 * Math.log10(strength),
      comparisons: comparisonWeights[index] ?? 0,
    }];
  }));
}

function percentile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 1_000;
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return (sorted[lower] ?? 1_000) * (1 - fraction) + (sorted[upper] ?? 1_000) * fraction;
}

function randomIndex(length: number, rng: () => number): number {
  const value = rng();
  if (!Number.isFinite(value)) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(value * length)));
}

export interface FitRatingsOptions extends BradleyTerryOptions {
  population?: RatingPopulation;
  stats?: ReadonlyMap<string, ModelStats>;
}

/** Fit one population and return Elo-scaled point estimates plus bootstrap intervals. */
export function fitBradleyTerry(
  comparisons: readonly Comparison[],
  modelSlugs: readonly string[],
  options: FitRatingsOptions = {},
): RatingEntry[] {
  const validated = validatedOptions(options);
  const slugs = [...new Set(modelSlugs)].sort();
  const population = options.population ?? "blended";
  const weighted = weightedForPopulation(comparisons, population, validated.blendedWeights);
  const point = fitPoint(slugs, weighted, validated);
  const samples = new Map(slugs.map((slug) => [slug, [] as number[]]));
  const rng = options.rng ?? Math.random;

  if (weighted.length > 0) {
    for (let sample = 0; sample < validated.bootstrapResamples; sample += 1) {
      const resampled = Array.from(
        { length: weighted.length },
        () => weighted[randomIndex(weighted.length, rng)]!,
      );
      const estimate = fitPoint(slugs, resampled, validated);
      for (const slug of slugs) samples.get(slug)!.push(estimate.get(slug)?.rating ?? 1_000);
    }
  }

  const emptyStats: ModelStats = {
    games: 0,
    wins: 0,
    avgPlacement: null,
    matchupWinRate: null,
    avgPoints: null,
  };
  return slugs.map((slug) => {
    const estimate = point.get(slug) ?? { strength: 1, rating: 1_000, comparisons: 0 };
    const intervals = samples.get(slug)!.sort((left, right) => left - right);
    return {
      modelSlug: slug,
      rating: estimate.rating,
      lower95: intervals.length ? percentile(intervals, 0.025) : estimate.rating,
      upper95: intervals.length ? percentile(intervals, 0.975) : estimate.rating,
      strength: estimate.strength,
      comparisons: estimate.comparisons,
      stats: options.stats?.get(slug) ?? emptyStats,
    };
  }).sort((left, right) => right.rating - left.rating || left.modelSlug.localeCompare(right.modelSlug));
}

interface RatingData {
  modelSlugs: string[];
  comparisons: Comparison[];
  stats: Map<string, ModelStats>;
}

async function readRatingData(db: ArenaDatabaseClient): Promise<RatingData> {
  const [modelRows, gameRows, playerRows, answerRows, voteRows] = await Promise.all([
    db.select({ slug: models.slug }).from(models),
    db.select({ id: games.id, status: games.status }).from(games),
    db.select().from(gamePlayers),
    db.select({
      gameId: answers.gameId,
      playerId: answers.playerId,
      matchupId: answers.matchupId,
      answerIndex: answers.answerIndex,
    }).from(answers),
    db.select({
      matchupId: votes.matchupId,
      choice: votes.choice,
      population: votes.population,
      weight: votes.weight,
    }).from(votes),
  ]);

  const modelByPlayer = new Map<string, string>();
  const completedGames = new Set(
    gameRows.filter((game) => game.status === "completed").map((game) => game.id),
  );
  const gameSets = new Map<string, Set<string>>();
  const wins = new Map<string, number>();
  const placements = new Map<string, number[]>();
  const points = new Map<string, number[]>();
  for (const player of playerRows) {
    if (!player.modelSlug) continue;
    modelByPlayer.set(`${player.gameId}\u0000${player.playerId}`, player.modelSlug);
    if (!completedGames.has(player.gameId)) continue;
    const played = gameSets.get(player.modelSlug) ?? new Set<string>();
    played.add(player.gameId);
    gameSets.set(player.modelSlug, played);
    const placement = player.observedPlacement ?? player.placement;
    const totalScore = player.observedScore ?? player.totalScore;
    if (placement !== null) {
      const values = placements.get(player.modelSlug) ?? [];
      values.push(placement);
      placements.set(player.modelSlug, values);
      if (placement === 1) wins.set(player.modelSlug, (wins.get(player.modelSlug) ?? 0) + 1);
    }
    if (totalScore !== null) {
      const values = points.get(player.modelSlug) ?? [];
      values.push(totalScore);
      points.set(player.modelSlug, values);
    }
  }

  const answerByMatchup = new Map<string, Map<number, string>>();
  for (const answer of answerRows) {
    if (!answer.matchupId) continue;
    const slug = modelByPlayer.get(`${answer.gameId}\u0000${answer.playerId}`);
    if (!slug) continue;
    const matchupAnswers = answerByMatchup.get(answer.matchupId) ?? new Map<number, string>();
    matchupAnswers.set(answer.answerIndex, slug);
    answerByMatchup.set(answer.matchupId, matchupAnswers);
  }

  // Matchup rows exist only after matchup.resolved. Those atomic comparisons
  // remain valid even when the containing game is later abandoned; game-level
  // appearances, standings, wins, and points above count completed games only.
  const comparisons: Comparison[] = [];
  const matchupWins = new Map<string, number>();
  const matchupTotals = new Map<string, number>();
  for (const vote of voteRows) {
    if (!vote.matchupId) continue;
    const matchupAnswers = answerByMatchup.get(vote.matchupId);
    if (!matchupAnswers || matchupAnswers.size !== 2) continue;
    const winner = matchupAnswers.get(vote.choice);
    const loser = [...matchupAnswers.entries()].find(([index]) => index !== vote.choice)?.[1];
    if (!winner || !loser || winner === loser || vote.weight <= 0) continue;
    comparisons.push({ winner, loser, population: vote.population, weight: vote.weight });
    matchupWins.set(winner, (matchupWins.get(winner) ?? 0) + vote.weight);
    matchupTotals.set(winner, (matchupTotals.get(winner) ?? 0) + vote.weight);
    matchupTotals.set(loser, (matchupTotals.get(loser) ?? 0) + vote.weight);
  }

  const modelSlugs = [...new Set([
    ...modelRows.map((model) => model.slug),
    ...playerRows.flatMap((player) => player.modelSlug ? [player.modelSlug] : []),
  ])];
  const average = (values: readonly number[] | undefined): number | null => (
    values?.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  );
  const stats = new Map(modelSlugs.map((slug): [string, ModelStats] => [slug, {
    games: gameSets.get(slug)?.size ?? 0,
    wins: wins.get(slug) ?? 0,
    avgPlacement: average(placements.get(slug)),
    matchupWinRate: matchupTotals.has(slug)
      ? (matchupWins.get(slug) ?? 0) / matchupTotals.get(slug)!
      : null,
    avgPoints: average(points.get(slug)),
  }]));
  return { modelSlugs, comparisons, stats };
}

/** Read all comparisons, compute all three populations, and snapshot the results. */
export async function computeRatings(
  db: ArenaDatabaseClient,
  options: ComputeRatingsOptions = {},
): Promise<RatingRun> {
  await abandonStaleGames(db, { ...(options.now === undefined ? {} : { now: options.now }) });
  await backfillCompletedGameScores(db);
  const data = await readRatingData(db);
  const computedAt = options.now ?? new Date();
  if (!Number.isFinite(computedAt.getTime())) throw new Error("Invalid ratings timestamp");
  const populations = Object.fromEntries(
    (["player", "audience", "blended"] as const).map((population) => [
      population,
      fitBradleyTerry(data.comparisons, data.modelSlugs, {
        ...options,
        population,
        stats: data.stats,
      }),
    ]),
  ) as Record<RatingPopulation, RatingEntry[]>;

  await db.transaction(async (transaction) => {
    for (const population of ["player", "audience", "blended"] as const) {
      await transaction.insert(ratingSnapshots).values({
        computedAt,
        population,
        method: METHOD,
        results: populations[population],
      });
    }
  });
  return { computedAt: computedAt.toISOString(), method: METHOD, populations };
}

function isRatingEntry(value: unknown): value is RatingEntry {
  return typeof value === "object" && value !== null
    && typeof (value as { modelSlug?: unknown }).modelSlug === "string"
    && typeof (value as { rating?: unknown }).rating === "number";
}

/** Return the newest population snapshot, enriched with current model metadata and stats. */
export async function leaderboard(
  db: ArenaDatabaseClient,
  population: RatingPopulation = "blended",
): Promise<LeaderboardEntry[]> {
  const [snapshot] = await db.select().from(ratingSnapshots)
    .where(eq(ratingSnapshots.population, population))
    .orderBy(desc(ratingSnapshots.computedAt), desc(ratingSnapshots.id))
    .limit(1);
  if (!snapshot || !Array.isArray(snapshot.results)) return [];

  const [data, modelRows] = await Promise.all([
    readRatingData(db),
    db.select().from(models),
  ]);
  const modelBySlug = new Map(modelRows.map((model) => [model.slug, model]));
  return snapshot.results.filter(isRatingEntry).map((entry) => {
    const model = modelBySlug.get(entry.modelSlug);
    return {
      ...entry,
      stats: data.stats.get(entry.modelSlug) ?? entry.stats,
      displayName: model?.displayName ?? entry.modelSlug.split("/").at(-1) ?? entry.modelSlug,
      lab: model?.lab ?? entry.modelSlug.split("/", 1)[0] ?? "unknown",
      enabled: model?.enabled ?? false,
      benched: model?.benchState?.benched === true,
      benchReason: model?.benchState?.benched === true ? model.benchState.reason ?? null : null,
      population,
      computedAt: snapshot.computedAt.toISOString(),
    };
  }).sort((left, right) => right.rating - left.rating || left.modelSlug.localeCompare(right.modelSlug));
}
