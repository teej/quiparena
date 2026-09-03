import type { Game, Matchup, Thriplash, Vote } from "@quiparena/core";

type ScoreMap = Record<string, number>;

export const ROUND_POOLS = { 1: 1_000, 2: 2_000, 3: 3_000 } as const;
export const WIN_BONUSES = { 1: 100, 2: 200, 3: 300 } as const;
export const QUIPLASH_BONUSES = { 1: 250, 2: 500, 3: 750 } as const;

/**
 * Rules source: https://jackboxgames.fandom.com/wiki/Quiplash_(series)#Game_Rules
 * documents a 1,000-point R1 vote pool (10 points per percentage point), a
 * 100-point win bonus, a 250-point Quiplash bonus instead of the win bonus,
 * and doubled R2 values. Its legacy Final Round section documents a
 * 3,000-point pool (30 points per percentage point). For the Recorder's
 * normalized all-entry Thriplash row, Arena applies that 3,000-point pool.
 * The source does not state Quiplash 3's R3 bonus arithmetic separately, so
 * the 3x win/Quiplash bonuses (300/750) are the commonly documented multiplier
 * and remain an explicitly marked inference pending a readable TV audit.
 *
 * The controller protocol has no scores (docs/quiplash3-controller.md), so we
 * calculate from captured votes. We apportion the pool by exact weighted vote
 * share with largest-remainder rounding; this preserves the whole pool and is
 * deterministic when thirds cannot be represented as integer points.
 */

interface ScoredChoice {
  ownerId: string;
  index: number;
}

function voteWeight(vote: Vote): number {
  const weight = vote.weight ?? 1;
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function apportionedScores(
  choices: readonly ScoredChoice[],
  votes: readonly Vote[],
  pool: number,
): ScoreMap {
  const weights = choices.map((_choice, index) => votes
    .filter((vote) => vote.choice === index)
    .reduce((sum, vote) => sum + voteWeight(vote), 0));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const scores = Object.fromEntries(choices.map((choice) => [choice.ownerId, 0])) as ScoreMap;
  if (totalWeight <= 0) return scores;

  const portions = choices.map((choice, index) => {
    const exact = pool * (weights[index] ?? 0) / totalWeight;
    const floor = Math.floor(exact);
    return { choice, exact, floor, fraction: exact - floor };
  });
  let remainder = pool - portions.reduce((sum, portion) => sum + portion.floor, 0);
  const remainderOrder = [...portions].sort((left, right) => (
    right.fraction - left.fraction || left.choice.index - right.choice.index
  ));
  for (const portion of remainderOrder) {
    scores[portion.choice.ownerId] = portion.floor + (remainder > 0 ? 1 : 0);
    remainder -= 1;
  }
  return scores;
}

function addWinnerBonus(
  scores: ScoreMap,
  choices: readonly ScoredChoice[],
  votes: readonly Vote[],
  round: 1 | 2 | 3,
): ScoreMap {
  const validVotes = votes.filter((vote) => (
    Number.isInteger(vote.choice)
    && vote.choice >= 0
    && vote.choice < choices.length
    && voteWeight(vote) > 0
  ));
  if (validVotes.length === 0) return scores;
  const weights = choices.map((_choice, index) => validVotes
    .filter((vote) => vote.choice === index)
    .reduce((sum, vote) => sum + voteWeight(vote), 0));
  const highest = Math.max(...weights);
  const winners = weights.flatMap((weight, index) => weight === highest ? [index] : []);
  if (winners.length !== 1) return scores;

  const winnerIndex = winners[0]!;
  const winner = choices[winnerIndex]!;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const bonus = weights[winnerIndex] === total
    ? QUIPLASH_BONUSES[round]
    : WIN_BONUSES[round];
  return { ...scores, [winner.ownerId]: (scores[winner.ownerId] ?? 0) + bonus };
}

function scoreChoices(
  choices: readonly ScoredChoice[],
  votes: readonly Vote[],
  round: 1 | 2 | 3,
): ScoreMap {
  const validVotes = votes.filter((vote) => (
    Number.isInteger(vote.choice)
    && vote.choice >= 0
    && vote.choice < choices.length
    && voteWeight(vote) > 0
  ));
  return addWinnerBonus(
    apportionedScores(choices, validVotes, ROUND_POOLS[round]),
    choices,
    validVotes,
    round,
  );
}

/** Score one resolved R1/R2 matchup without mutating it. */
export function scoreMatchup(matchup: Matchup): Matchup {
  const choices = matchup.answers.map((answer, index) => ({
    ownerId: answer.playerId,
    index,
  }));
  return { ...matchup, scores: scoreChoices(choices, matchup.votes, matchup.round) };
}

/** Score the Recorder's normalized all-entry Thriplash result without mutation. */
export function scoreThriplash(thriplash: Thriplash): Thriplash {
  const choices = thriplash.entries.map((entry, index) => ({
    ownerId: entry.playerId,
    index,
  }));
  return { ...thriplash, scores: scoreChoices(choices, thriplash.votes, 3) };
}

export interface TotalScoresInput {
  playerIds: readonly string[];
  matchups: readonly Matchup[];
  thriplash?: Thriplash;
}

/** Sum freshly computed round scores for every player, including zeroes. */
export function totalScores(input: TotalScoresInput): ScoreMap {
  const totals = Object.fromEntries(input.playerIds.map((playerId) => [playerId, 0])) as ScoreMap;
  const rounds = [
    ...input.matchups.map((matchup) => scoreMatchup(matchup).scores ?? {}),
    ...(input.thriplash ? [scoreThriplash(input.thriplash).scores ?? {}] : []),
  ];
  for (const round of rounds) {
    for (const [playerId, score] of Object.entries(round)) {
      totals[playerId] = (totals[playerId] ?? 0) + score;
    }
  }
  return totals;
}

/** Standard-competition placements: equal scores share a place (1, 1, 3). */
export function placementsFromScores(
  scores: Readonly<ScoreMap>,
  playerOrder: readonly string[] = Object.keys(scores),
): ScoreMap {
  const orderIndex = new Map(playerOrder.map((playerId, index) => [playerId, index]));
  const ordered = Object.entries(scores).sort((left, right) => (
    right[1] - left[1]
    || (orderIndex.get(left[0]) ?? Number.MAX_SAFE_INTEGER)
      - (orderIndex.get(right[0]) ?? Number.MAX_SAFE_INTEGER)
    || left[0].localeCompare(right[0])
  ));
  const placements: ScoreMap = {};
  let previousScore: number | undefined;
  let placement = 0;
  ordered.forEach(([playerId, score], index) => {
    if (previousScore === undefined || score !== previousScore) placement = index + 1;
    placements[playerId] = placement;
    previousScore = score;
  });
  return placements;
}

/** Populate every nested round score and the computed final score map. */
export function scoreGame(game: Game): Game {
  const matchups = game.matchups.map(scoreMatchup);
  const thriplash = game.thriplash ? scoreThriplash(game.thriplash) : undefined;
  const finalScores = totalScores({
    playerIds: game.players.map((player) => player.id),
    matchups,
    ...(thriplash === undefined ? {} : { thriplash }),
  });
  return {
    ...game,
    matchups,
    ...(thriplash === undefined ? {} : { thriplash }),
    finalScores,
  };
}
