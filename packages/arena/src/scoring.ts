import type { Game, Matchup, Thriplash, Vote } from "@quiparena/core";

type ScoreMap = Record<string, number>;

export const ROUND_POOLS = { 1: 1_000, 2: 2_000, 3: 6_000 } as const;
export const WIN_BONUSES = { 1: 100, 2: 200, 3: 600 } as const;
export const QUIPLASH_BONUSES = { 1: 250, 2: 500, 3: 750 } as const;

/**
 * Rules source: https://jackboxgames.fandom.com/wiki/Quiplash_(series)#Game_Rules
 * documents a 1,000-point R1 vote pool (10 points per percentage point), a
 * 100-point win bonus, a 250-point Quiplash bonus instead of the win bonus,
 * and doubled R2 values. Quiplash 3's accessible TV narration and final
 * standings provide the missing Thriplash details: each pair of entries has a
 * 6,000-point pool (60 points per displayed percentage point), a 600-point win
 * bonus, or a 750-point unanimous "Thriplash" bonus instead. See
 * `scoring audit`; e.g. ZSAX-1788413979845-1 records 33/67 as 1,980/4,620 and
 * 0/100 as 0/6,750.
 *
 * The controller protocol has no scores (docs/quiplash3-controller.md), so we
 * calculate from captured votes. The game first rounds each weighted vote
 * share to a whole displayed percentage, then multiplies it by the round's
 * points-per-percent value. It does not preserve an exact pool split: 1/6 and
 * 5/6 votes are displayed as 17/83 and score 170/830 before bonuses.
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
  const weights = choices.map((choice) => votes
    .filter((vote) => vote.choice === choice.index)
    .reduce((sum, vote) => sum + voteWeight(vote), 0));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const scores = Object.fromEntries(choices.map((choice) => [choice.ownerId, 0])) as ScoreMap;
  if (totalWeight <= 0) return scores;

  const pointsPerPercent = pool / 100;
  for (const [index, choice] of choices.entries()) {
    const percentage = Math.round(100 * (weights[index] ?? 0) / totalWeight);
    scores[choice.ownerId] = percentage * pointsPerPercent;
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
    && choices.some((choice) => choice.index === vote.choice)
    && voteWeight(vote) > 0
  ));
  if (validVotes.length === 0) return scores;
  const weights = choices.map((choice) => validVotes
    .filter((vote) => vote.choice === choice.index)
    .reduce((sum, vote) => sum + voteWeight(vote), 0));
  const highest = Math.max(...weights);
  const winners = weights.flatMap((weight, index) => weight === highest ? [index] : []);
  if (winners.length !== 1) return scores;

  const winnerPosition = winners[0]!;
  const winner = choices[winnerPosition]!;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const bonus = weights[winnerPosition] === total
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
    && choices.some((choice) => choice.index === vote.choice)
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

function thriplashEntryPrompt(entry: Thriplash["entries"][number], fallback: string): string {
  const prompt = entry.prompt?.trim() || fallback;
  return prompt.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

/** Score each head-to-head pair in the Recorder's normalized Thriplash result. */
export function scoreThriplash(thriplash: Thriplash): Thriplash {
  const grouped = new Map<string, ScoredChoice[]>();
  for (const [index, entry] of thriplash.entries.entries()) {
    const prompt = thriplashEntryPrompt(entry, thriplash.prompt);
    const choices = grouped.get(prompt) ?? [];
    choices.push({ ownerId: entry.playerId, index });
    grouped.set(prompt, choices);
  }

  const scores = Object.fromEntries(
    thriplash.entries.map((entry) => [entry.playerId, 0]),
  ) as ScoreMap;
  for (const choices of grouped.values()) {
    const choiceIndexes = new Set(choices.map((choice) => choice.index));
    const pairVotes = thriplash.votes.filter((vote) => choiceIndexes.has(vote.choice));
    // GSKR-1788587749561-3: a full entry against three blank lines skips
    // voting and receives the 6,000-point pool, without a winner bonus.
    if (choices.length === 2 && pairVotes.length === 0) {
      const complete = choices.filter((choice) => (
        thriplash.entries[choice.index]!.lines.every((line) => line.trim().length > 0)
      ));
      const blank = choices.filter((choice) => (
        thriplash.entries[choice.index]!.lines.every((line) => line.trim().length === 0)
      ));
      if (complete.length === 1 && blank.length === 1) {
        scores[complete[0]!.ownerId] = (scores[complete[0]!.ownerId] ?? 0) + ROUND_POOLS[3];
        continue;
      }
    }
    for (const [playerId, score] of Object.entries(scoreChoices(choices, pairVotes, 3))) {
      scores[playerId] = (scores[playerId] ?? 0) + score;
    }
  }
  return { ...thriplash, scores };
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
