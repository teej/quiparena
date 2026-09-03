#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { PlayerContext } from "@quiparena/jackbox";
import { desc } from "drizzle-orm";

import { openDb, type ArenaDatabase } from "./db/client.js";
import { games } from "./db/schema.js";
import { ConsoleSink, ModelPlayer, type ModelPlayerConfig } from "./model-player.js";
import { computeRatings, leaderboard, type RatingPopulation } from "./ratings.js";
import { loadGame } from "./recorder.js";
import { findRosterModel, loadRoster, validateRoster, type ModelRoster } from "./registry.js";

function usage(): string {
  return [
    "Usage:",
    "  quiparena ask --model <slug> --prompt <text> [--deadline-s 30]",
    "  quiparena vote --model <slug> --prompt <text> --a <answer> --b <answer> [--deadline-s 30]",
    "  quiparena roster",
    "  quiparena db migrate",
    "  quiparena ratings compute [--bootstrap 200]",
    "  quiparena ratings show [--population blended]",
    "  quiparena games list [--limit 20]",
    "  quiparena games show <id>",
    "",
    "From the workspace:",
    "  pnpm --filter @quiparena/arena ask --model <slug> --prompt <text>",
  ].join("\n");
}

async function usingDb<T>(run: (db: ArenaDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await run(db);
  } finally {
    await db.close();
  }
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`Missing required ${flag}`);
  return value;
}

function deadlineMs(value: string | undefined): number {
  const seconds = value === undefined ? 30 : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--deadline-s must be a positive number");
  }
  return Date.now() + seconds * 1_000;
}

function displayNameFor(slug: string): string {
  const segment = slug.split("/").at(-1) ?? "Model";
  const name = segment.replace(/[^a-z0-9.-]+/gi, " ").trim();
  return (name || "Model").slice(0, 12);
}

function playerConfig(slug: string, roster: ModelRoster): ModelPlayerConfig {
  const entry = findRosterModel(roster, slug);
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set (expected in the repository .env)");

  return {
    model: slug,
    displayName: entry?.displayName ?? displayNameFor(slug),
    playerId: `cli:${slug}`,
    sink: (event) => {
      process.stdout.write("\ntrace> ");
      return ConsoleSink(event);
    },
    apiKey,
    ...(entry?.reasoning == null ? {} : { reasoning: entry.reasoning }),
    ...(entry?.temperature == null ? {} : { temperature: entry.temperature }),
  };
}

function streamingContext(deadline: number, round: 1 | 2 | 3): PlayerContext {
  let thinkingStarted = false;
  let draftStarted = false;
  return {
    gameId: `cli-${Date.now()}`,
    round,
    deadlineMs: deadline,
    onThinking: (delta) => {
      if (!thinkingStarted) {
        process.stderr.write("thinking> ");
        thinkingStarted = true;
      }
      process.stderr.write(delta);
    },
    onDraft: (delta) => {
      if (!draftStarted) {
        process.stdout.write("draft> ");
        draftStarted = true;
      }
      process.stdout.write(delta);
    },
  };
}

async function runAsk(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string" },
      prompt: { type: "string" },
      "deadline-s": { type: "string" },
    },
    strict: true,
  });
  const slug = required(values.model, "--model");
  const prompt = required(values.prompt, "--prompt");
  const roster = await loadRoster();
  const player = new ModelPlayer(playerConfig(slug, roster));
  const answer = await player.answer(prompt, streamingContext(deadlineMs(values["deadline-s"]), 1));
  process.stdout.write(`\nanswer> ${answer}\n`);
}

async function runVote(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string" },
      prompt: { type: "string" },
      a: { type: "string" },
      b: { type: "string" },
      "deadline-s": { type: "string" },
    },
    strict: true,
  });
  const slug = required(values.model, "--model");
  const prompt = required(values.prompt, "--prompt");
  const options = [required(values.a, "--a"), required(values.b, "--b")];
  const roster = await loadRoster();
  const player = new ModelPlayer(playerConfig(slug, roster));
  const choice = await player.vote(
    prompt,
    options,
    streamingContext(deadlineMs(values["deadline-s"]), 1),
  );
  process.stdout.write(`\nvote> ${choice} (${options[choice] ?? "unknown"})\n`);
}

async function runRoster(args: string[]): Promise<void> {
  parseArgs({ args, options: {}, strict: true });
  const roster = await loadRoster();
  const report = await validateRoster(roster);
  console.log(`${roster.reviewStatus}; catalog checked ${roster.catalogCheckedAt}`);
  for (const entry of roster.models) {
    const unknown = report.unknown.includes(entry.slug);
    const unsupported = report.unsupported.find((item) => item.slug === entry.slug);
    const status = unknown ? "unknown" : unsupported ? "unsupported" : "ok";
    const suffix = unsupported ? ` — ${unsupported.reasons.join("; ")}` : "";
    console.log(`[${status}] ${entry.slug} (${entry.displayName}, ${entry.released})${suffix}`);
  }
  console.log(`Checked ${report.checked} roster entries against ${report.catalogSize} OpenRouter models.`);
  if (!report.ok) process.exitCode = 1;
}

async function runDb(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command !== "migrate") throw new Error(`Usage: quiparena db migrate`);
  parseArgs({ args: rest, options: {}, strict: true });
  await usingDb(async (db) => {
    console.log(`Database migrations are current (${db.$driver}).`);
  });
}

function ratingPopulation(value: string | undefined): RatingPopulation {
  const population = value ?? "blended";
  if (population !== "player" && population !== "audience" && population !== "blended") {
    throw new Error("--population must be player, audience, or blended");
  }
  return population;
}

async function runRatings(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "compute") {
    const { values } = parseArgs({
      args: rest,
      options: { bootstrap: { type: "string" } },
      strict: true,
    });
    const bootstrapResamples = values.bootstrap === undefined ? undefined : Number(values.bootstrap);
    if (bootstrapResamples !== undefined
      && (!Number.isInteger(bootstrapResamples) || bootstrapResamples < 0)) {
      throw new Error("--bootstrap must be a non-negative integer");
    }
    await usingDb(async (db) => {
      const result = await computeRatings(db, {
        ...(bootstrapResamples === undefined ? {} : { bootstrapResamples }),
      });
      console.log(`Computed ${result.method} ratings at ${result.computedAt}.`);
      for (const population of ["player", "audience", "blended"] as const) {
        console.log(`${population}: ${result.populations[population].length} models`);
      }
    });
    return;
  }
  if (command === "show") {
    const { values } = parseArgs({
      args: rest,
      options: { population: { type: "string" } },
      strict: true,
    });
    const population = ratingPopulation(values.population);
    await usingDb(async (db) => {
      const entries = await leaderboard(db, population);
      if (entries.length === 0) {
        console.log(`No ${population} rating snapshot. Run \"quiparena ratings compute\" first.`);
        return;
      }
      for (const [index, entry] of entries.entries()) {
        console.log(
          `${String(index + 1).padStart(2)}  ${entry.rating.toFixed(0).padStart(4)}`
          + `  [${entry.lower95.toFixed(0)}, ${entry.upper95.toFixed(0)}]`
          + `  ${entry.displayName} (${entry.modelSlug})`
          + `  games=${entry.stats.games} wins=${entry.stats.wins}`,
        );
      }
    });
    return;
  }
  throw new Error("Usage: quiparena ratings <compute|show>");
}

async function runGames(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "list") {
    const { values } = parseArgs({
      args: rest,
      options: { limit: { type: "string" } },
      strict: true,
    });
    const limit = values.limit === undefined ? 20 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
    await usingDb(async (db) => {
      const rows = await db.select().from(games).orderBy(desc(games.startedAt)).limit(limit);
      for (const game of rows) {
        console.log(
          `${game.id}  ${game.roomCode || "-"}  ${game.status}`
          + `  ${game.startedAt.toISOString()}${game.endedAt ? ` → ${game.endedAt.toISOString()}` : ""}`,
        );
      }
    });
    return;
  }
  if (command === "show") {
    const [id, ...extra] = rest;
    if (!id || extra.length > 0) throw new Error("Usage: quiparena games show <id>");
    await usingDb(async (db) => {
      const game = await loadGame(db, id);
      if (!game) throw new Error(`Game not found: ${id}`);
      console.log(JSON.stringify(game, null, 2));
    });
    return;
  }
  throw new Error("Usage: quiparena games <list|show>");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "ask":
      await runAsk(args);
      break;
    case "vote":
      await runVote(args);
      break;
    case "roster":
      await runRoster(args);
      break;
    case "db":
      await runDb(args);
      break;
    case "ratings":
      await runRatings(args);
      break;
    case "games":
      await runGames(args);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(usage());
      break;
    default:
      throw new Error(command ? `Unknown command: ${command}\n${usage()}` : usage());
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
