import { readFile } from "node:fs/promises";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { asc, eq } from "drizzle-orm";

import type { ArenaDatabaseClient } from "../db/client.js";
import { gamePlayers, games, type ObservedScore } from "../db/schema.js";
import { DEFAULT_VISION_MODEL } from "./read-code.js";

export type GenerateScoresText = (image: Uint8Array, prompt: string) => Promise<string>;

export interface ReadFinalScoresOptions {
  apiKey?: string;
  model?: string;
  /** Test seam for a deterministic mocked vision model. */
  generate?: GenerateScoresText;
}

export interface ScoreMismatch {
  name: string;
  computed: number | null;
  observed: number;
}

export interface CaptureFinalScoresResult {
  scores: ObservedScore[];
  mismatches: ScoreMismatch[];
}

export interface CaptureFinalScoresOptions extends ReadFinalScoresOptions {
  logger?: Pick<Console, "info" | "warn">;
}

function jsonCandidate(output: string): string {
  const unfenced = output.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  return start >= 0 && end >= start ? unfenced.slice(start, end + 1) : unfenced;
}

/** Parse and require one exact, finite integer score for every expected player. */
export function parseFinalScores(
  output: string,
  expectedNames: readonly string[],
): ObservedScore[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate(output));
  } catch (error) {
    throw new Error(`Vision score output was not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("Vision score output must be a JSON array");

  const expected = new Map(expectedNames.map((name) => [name.toLocaleLowerCase("en-US"), name]));
  if (expected.size !== expectedNames.length) throw new Error("Game player names are not unique");
  const seen = new Set<string>();
  const byName = new Map<string, ObservedScore>();
  for (const value of parsed) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Every observed score must be an object");
    }
    const candidate = value as Record<string, unknown>;
    const rawName = candidate["name"];
    const score = candidate["score"];
    if (typeof rawName !== "string" || !Number.isSafeInteger(score) || Number(score) < 0) {
      throw new Error("Every observed score requires a player name and non-negative integer score");
    }
    const key = rawName.trim().toLocaleLowerCase("en-US");
    const canonicalName = expected.get(key);
    if (!canonicalName) throw new Error(`Vision returned unknown player name: ${rawName}`);
    if (seen.has(key)) throw new Error(`Vision returned player twice: ${canonicalName}`);
    seen.add(key);
    byName.set(key, { name: canonicalName, score: Number(score) });
  }
  const missing = expectedNames.filter((name) => !seen.has(name.toLocaleLowerCase("en-US")));
  if (missing.length > 0) throw new Error(`Vision omitted players: ${missing.join(", ")}`);
  return expectedNames.map((name) => byName.get(name.toLocaleLowerCase("en-US"))!);
}

function defaultGenerator(apiKey: string | undefined, modelSlug: string): GenerateScoresText {
  const provider = createOpenRouter({
    ...(apiKey === undefined ? {} : { apiKey }),
    appName: "QuipArena Score Reader",
    compatibility: "strict",
  });
  const model = provider.chat(modelSlug);
  return async (image, prompt) => {
    const result = await generateText({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "file", data: image, mediaType: "image/png" },
        ],
      }],
      maxOutputTokens: 256,
      temperature: 0,
      maxRetries: 1,
      providerOptions: { openrouter: { reasoning: { effort: "none" } } },
    });
    return result.text;
  };
}

/** Read a Quiplash 3 final-standings PNG with a vision model. */
export async function readFinalScores(
  imagePath: string,
  expectedNames: readonly string[],
  options: ReadFinalScoresOptions = {},
): Promise<ObservedScore[]> {
  if (expectedNames.length === 0) throw new Error("The game has no players to validate");
  const prompt = [
    "Inspect this Quiplash 3 screenshot and transcribe the final standings scores.",
    `The exact player names are: ${expectedNames.map((name) => JSON.stringify(name)).join(", ")}.`,
    "Return only a JSON array with exactly one object per player: [{\"name\":\"...\",\"score\":1234}].",
    "Copy displayed integer scores exactly. Do not infer or calculate scores.",
    "If this is not a final standings screen or any score is unreadable, return [].",
  ].join("\n");
  const image = await readFile(imagePath);
  const modelSlug = options.model ?? process.env["HOST_AGENT_VISION_MODEL"] ?? DEFAULT_VISION_MODEL;
  const generate = options.generate
    ?? defaultGenerator(options.apiKey ?? process.env["OPENROUTER_API_KEY"], modelSlug);
  return parseFinalScores(await generate(image, prompt), expectedNames);
}

/** Validate, store the observed name/score rows, and report computed mismatches. */
export async function captureFinalScores(
  db: ArenaDatabaseClient,
  gameId: string,
  imagePath: string,
  options: CaptureFinalScoresOptions = {},
): Promise<CaptureFinalScoresResult> {
  const logger = options.logger ?? console;
  const playerRows = await db.select({
    playerId: gamePlayers.playerId,
    name: gamePlayers.name,
    totalScore: gamePlayers.totalScore,
  }).from(gamePlayers)
    .where(eq(gamePlayers.gameId, gameId))
    .orderBy(asc(gamePlayers.seat));
  if (playerRows.length === 0) throw new Error(`Game not found or has no players: ${gameId}`);

  const scores = await readFinalScores(
    imagePath,
    playerRows.map((player) => player.name),
    options,
  );
  await db.update(games).set({ observedScores: scores }).where(eq(games.id, gameId));

  const playerByName = new Map(playerRows.map((player) => [
    player.name.toLocaleLowerCase("en-US"),
    player,
  ]));
  const mismatches = scores.flatMap((observed): ScoreMismatch[] => {
    const computed = playerByName.get(observed.name.toLocaleLowerCase("en-US"))?.totalScore ?? null;
    return computed === observed.score ? [] : [{ name: observed.name, computed, observed: observed.score }];
  });
  if (mismatches.length === 0) {
    logger.info(`[quiparena/host-agent] observed scores match computed scores for ${gameId}`);
  } else {
    logger.warn(
      `[quiparena/host-agent] score mismatch for ${gameId}: `
      + mismatches.map((item) => `${item.name} computed=${item.computed ?? "missing"} observed=${item.observed}`).join("; "),
    );
  }
  return { scores, mismatches };
}
