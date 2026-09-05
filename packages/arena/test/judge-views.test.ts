import { describe, expect, it } from "vitest";
import { adjustJudgeVotes, type Comparison } from "../src/ratings.js";
import { pickNextLobby } from "../src/lobby.js";

const comparison = (judgeFamily: string, winnerFamily = "A"): Comparison => ({
  winner: `${winnerFamily}/winner`, loser: "B/loser", winnerFamily, loserFamily: "B",
  judgeFamily, weight: 1, population: "player", matchupId: "m", gameId: "g",
});
describe("judge family views", () => {
  it("excludes judges related to either contestant even when they vote against their family", () => {
    const votes = [comparison("A"), comparison("B"), comparison("C")];
    expect(adjustJudgeVotes(votes, "cross-family")).toEqual([votes[2]]);
    expect(adjustJudgeVotes(votes, "standard")).toEqual(votes);
  });
  it("gives each represented family equal influence within each matchup", () => {
    const votes = [comparison("A"), comparison("A"), comparison("A"), comparison("C")];
    const adjusted = adjustJudgeVotes(votes, "family-balanced");
    expect(adjusted.filter(v => v.judgeFamily === "A").reduce((s, v) => s + v.weight, 0)).toBe(2);
    expect(adjusted.find(v => v.judgeFamily === "C")?.weight).toBe(2);
    expect(votes.every(v => v.weight === 1)).toBe(true);
  });
});
it("samples all eligible seats afresh without retaining winners or fixed models", () => {
  const roster = Array.from({ length: 12 }, (_, i) => ({ slug: `m/${i}`, enabled: i !== 11, fixed: i === 0 }));
  const result = pickNextLobby({ roster, size: 8, history: [], rng: () => 0.999,
    lastGame: { players: [{ modelSlug: "m/0", placement: 1 }, { modelSlug: "m/1", placement: 2 }] },
    benchStates: { "m/10": { benched: true, gamesRemaining: 1, consecutiveSlowGames: 0 } },
  }).map(m => m.slug);
  expect(result).toEqual(["m/9", "m/8", "m/7", "m/6", "m/5", "m/4", "m/3", "m/2"]);
});
