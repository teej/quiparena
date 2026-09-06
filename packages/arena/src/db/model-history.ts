import { and, desc, eq, inArray, or, sum } from "drizzle-orm";
import type { ArenaDatabaseClient } from "./client.js";
import { answers, gamePlayers, games, matchups, models, thriplashes, votes } from "./schema.js";

export async function modelHistory(db: ArenaDatabaseClient, slug: string, offset = 0, limit = 50) {
  const [model] = await db.select({ slug: models.slug, name: models.displayName, lab: models.lab })
    .from(models).where(eq(models.slug, slug));
  if (!model) return null;
  const rows = await db.select({
    id: answers.id, gameId: games.id, startedAt: games.startedAt, round: matchups.round,
    prompt: answers.prompt, matchupPrompt: matchups.prompt, finalPrompt: thriplashes.prompt,
    matchupId: answers.matchupId, thriplashId: answers.thriplashId, playerId: answers.playerId, answerIndex: answers.answerIndex,
    matchupScores: matchups.scores, finalScores: thriplashes.scores,
    text: answers.text, lines: answers.lines, blank: answers.blank,
  }).from(answers)
    .innerJoin(gamePlayers, and(eq(answers.gameId, gamePlayers.gameId), eq(answers.playerId, gamePlayers.playerId)))
    .innerJoin(games, eq(games.id, answers.gameId))
    .leftJoin(matchups, eq(matchups.id, answers.matchupId))
    .leftJoin(thriplashes, eq(thriplashes.id, answers.thriplashId))
    .where(eq(gamePlayers.modelSlug, slug))
    .orderBy(desc(games.startedAt), desc(answers.id)).limit(limit + 1).offset(offset);
  const page = rows.slice(0, limit);
  const matchupIds = [...new Set(page.flatMap(row => row.matchupId ? [row.matchupId] : []))];
  const finalIds = [...new Set(page.flatMap(row => row.thriplashId ? [row.thriplashId] : []))];
  const targets = (table: typeof answers | typeof votes) => or(
    matchupIds.length ? inArray(table.matchupId, matchupIds) : undefined,
    finalIds.length ? inArray(table.thriplashId, finalIds) : undefined,
  );
  const [peers, tallies] = page.length === 0 ? [[], []] : await Promise.all([
    db.select({ matchupId: answers.matchupId, thriplashId: answers.thriplashId,
      playerId: answers.playerId, answerIndex: answers.answerIndex, prompt: answers.prompt })
      .from(answers).where(targets(answers)),
    db.select({ matchupId: votes.matchupId, thriplashId: votes.thriplashId,
      choice: votes.choice, count: sum(votes.weight) }).from(votes).where(targets(votes))
      .groupBy(votes.matchupId, votes.thriplashId, votes.choice),
  ]);
  const normalize = (prompt: string) => prompt.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  return { model, offset, hasMore: rows.length > limit, answers: page.map(row => {
    const prompt = row.prompt ?? row.matchupPrompt ?? row.finalPrompt ?? "Unknown prompt";
    const contestants = peers.filter(peer => row.matchupId ? peer.matchupId === row.matchupId
      : peer.thriplashId === row.thriplashId && normalize(peer.prompt?.trim() || row.finalPrompt || "") === normalize(row.prompt?.trim() || row.finalPrompt || ""));
    const counts = tallies.filter(tally => row.matchupId ? tally.matchupId === row.matchupId : tally.thriplashId === row.thriplashId);
    const scores = row.matchupScores ?? row.finalScores;
    const result = jokeResult(row.answerIndex, contestants.map(peer => ({
      index: peer.answerIndex,
      votes: Number(counts.find(tally => tally.choice === peer.answerIndex)?.count ?? 0),
      score: scores?.[peer.playerId] ?? 0,
    })));
    return {
      id: row.id, gameId: row.gameId, startedAt: row.startedAt.toISOString(), round: row.round ?? 3,
      prompt, text: row.lines ? row.lines.join("\n") : row.text, blank: row.blank, result,
    };
  }) };
}

/** Zero recorded votes are not evidence of a tie. Scores can identify an automatic win. */
export function jokeResult(index: number, choices: Array<{ index: number; votes: number; score: number }>) {
  const own = choices.find(choice => choice.index === index);
  if (!own || choices.length < 2) return null;
  const totalVotes = choices.reduce((sum, choice) => sum + choice.votes, 0);
  const automatic = totalVotes === 0 && choices.some(choice => choice.score > 0);
  if (totalVotes === 0 && !automatic) return null;
  const value = (choice: typeof own) => automatic ? choice.score : choice.votes;
  const best = Math.max(...choices.map(value));
  const outcome: "won" | "tied" | "lost" = value(own) < best ? "lost"
    : choices.filter(choice => value(choice) === best).length > 1 ? "tied" : "won";
  return { outcome, votes: own.votes, totalVotes, automatic };
}
