#!/usr/bin/env node

import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { AnyEvent, Game } from "@quiparena/core";
import { ScriptedPlayer, type Player, type PlayerContext } from "@quiparena/jackbox";
import { desc } from "drizzle-orm";

import { openDb, type ArenaDatabase } from "./db/client.js";
import { games } from "./db/schema.js";
import { runHostAgent } from "./host-agent/host-agent.js";
import { ConsoleSink, ModelPlayer, type ModelPlayerConfig } from "./model-player.js";
import { computeRatings, leaderboard, type RatingPopulation } from "./ratings.js";
import { loadGame } from "./recorder.js";
import { findRosterModel, loadRoster, validateRoster, type ModelRoster } from "./registry.js";
import type { RosterModel } from "./registry.js";
import { WorkerEventBus } from "./worker/bus.js";
import { FakeHarness } from "./worker/fake-harness.js";
import { runGame } from "./worker/game-runner.js";
import { runLoop } from "./worker/loop.js";
import { DbSink, IngestSink, JsonlSink, type WorkerSink } from "./worker/sinks.js";

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
    "  quiparena play --room CODE [--models slug,slug,...] [--players 8] [--record DIR] [--db] [--ingest URL]",
    "  quiparena loop --room CODE [--room-file PATH] [--db] [--ingest URL]",
    "  quiparena host-agent --room-file PATH [--interval-s 15] [--once] [--image PATH]",
    "  quiparena dry-run [--players 8]",
    "",
    "From the workspace:",
    "  pnpm --filter @quiparena/arena ask --model <slug> --prompt <text>",
  ].join("\n");
}

const DEFAULT_WORKER_CREDENTIALS = fileURLToPath(
  new URL("../.data/worker-credentials.json", import.meta.url),
);

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
    maxLength: 45,
    ...(round === 3 ? { fieldCount: 3 } : {}),
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

function playerCount(value: string | undefined, fallback = 8): number {
  const count = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(count) || count < 3 || count > 8) {
    throw new Error("--players must be an integer from 3 to 8");
  }
  return count;
}

function workerRoster(roster: ModelRoster, modelsValue: string | undefined, countValue: string | undefined): RosterModel[] {
  const requested = modelsValue?.split(",").map((slug) => slug.trim()).filter(Boolean);
  if (requested && new Set(requested).size !== requested.length) {
    throw new Error("--models must not contain duplicates");
  }
  const count = playerCount(countValue, requested?.length ?? 8);
  const candidates = requested
    ? requested.map((slug) => {
        const entry = findRosterModel(roster, slug);
        if (!entry) throw new Error(`Model is not in packages/arena/models.json: ${slug}`);
        return entry;
      })
    : roster.models.filter((entry) => entry.enabled);
  if (candidates.length < count) {
    throw new Error(`Need ${count} models but only ${candidates.length} were selected`);
  }
  return candidates.slice(0, count);
}

function workerSignal(): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

function compactLiveLog(bus: WorkerEventBus): {
  costs: Map<string, number>;
  printCosts(game: Game): void;
} {
  const names = new Map<string, string>();
  const models = new Map<string, string>();
  const voteOptions = new Map<string, string[]>();
  const shownPrompts = new Set<string>();
  const costs = new Map<string, number>();
  const label = (playerId: string): string => names.get(playerId) ?? playerId;

  bus.on((event: AnyEvent) => {
    switch (event.type) {
      case "player.joined":
        names.set(event.player.id, event.player.name);
        if (event.player.modelId) models.set(event.player.id, event.player.modelId);
        console.log(`join  ${event.player.name}${event.player.modelId ? ` (${event.player.modelId})` : ""}`);
        break;
      case "prompt.dealt": {
        const key = `${event.gameId}\0${event.round}\0${event.prompt}`;
        if (!shownPrompts.has(key)) {
          shownPrompts.add(key);
          console.log(`R${event.round} prompt  ${event.prompt}`);
        }
        break;
      }
      case "answer.submitted":
        console.log(`  ${label(event.playerId)}: ${Array.isArray(event.answer) ? event.answer.join(" / ") : event.answer}${event.blank ? " [fallback]" : ""}`);
        break;
      case "vote.requested":
        voteOptions.set(`${event.gameId}\0${event.playerId}\0${event.prompt}`, event.options);
        break;
      case "vote.cast": {
        const options = voteOptions.get(`${event.gameId}\0${event.playerId}\0${event.prompt}`);
        console.log(`  vote ${label(event.playerId)} → ${options?.[event.choice] ?? `#${event.choice + 1}`}`);
        break;
      }
      case "matchup.resolved": {
        const [left, right] = event.matchup.answers;
        const leftVotes = event.matchup.votes.filter((vote) => vote.choice === 0)
          .reduce((sum, vote) => sum + (vote.weight ?? 1), 0);
        const rightVotes = event.matchup.votes.filter((vote) => vote.choice === 1)
          .reduce((sum, vote) => sum + (vote.weight ?? 1), 0);
        console.log(`  result ${label(left.playerId)} ${leftVotes}–${rightVotes} ${label(right.playerId)}`);
        break;
      }
      case "thriplash.resolved":
        console.log(`  thriplash resolved (${event.thriplash.votes.length} votes)`);
        break;
      case "game.ended":
        console.log(event.finalScores
          ? `final ${Object.entries(event.finalScores).sort((a, b) => b[1] - a[1]).map(([id, score]) => `${label(id)}=${score}`).join("  ")}`
          : "final scores unavailable from controller");
        break;
      case "trace.completed": {
        const model = models.get(event.playerId) ?? event.playerId;
        costs.set(model, (costs.get(model) ?? 0) + (event.usage?.costUsd ?? 0));
        break;
      }
      case "harness.error":
        console.error(`error ${event.playerId ? `${label(event.playerId)}: ` : ""}${event.message}`);
        break;
      default:
        break;
    }
  });

  return {
    costs,
    printCosts: (game) => {
      console.log("costs");
      for (const player of game.players) {
        const model = player.modelId ?? player.name;
        console.log(`  ${player.name}: $${(costs.get(model) ?? 0).toFixed(6)}`);
      }
      console.log(`  total: $${[...costs.values()].reduce((sum, value) => sum + value, 0).toFixed(6)}`);
    },
  };
}

async function closeSinks(bus: WorkerEventBus, sinks: WorkerSink[], db?: ArenaDatabase): Promise<void> {
  await bus.flush();
  for (const sink of [...sinks].reverse()) {
    try {
      await sink.close?.();
    } catch (error) {
      console.error(`Could not close worker sink: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await db?.close();
}

async function runPlay(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      room: { type: "string" },
      models: { type: "string" },
      players: { type: "string" },
      record: { type: "string" },
      db: { type: "boolean" },
      ingest: { type: "string" },
    },
    strict: true,
  });
  const roomCode = required(values.room, "--room").toUpperCase();
  if (!process.env["OPENROUTER_API_KEY"]) throw new Error("OPENROUTER_API_KEY is not set");
  const roster = workerRoster(await loadRoster(), values.models, values.players);
  const bus = new WorkerEventBus();
  const live = compactLiveLog(bus);
  const sinks: WorkerSink[] = [];
  let db: ArenaDatabase | undefined;
  try {
    if (values.db) {
      db = await openDb();
      sinks.push(new DbSink(db));
    }
    const ingestUrl = values.ingest ?? process.env["WEB_INGEST_URL"];
    if (ingestUrl) sinks.push(new IngestSink({ url: ingestUrl }));
    if (values.record) sinks.push(new JsonlSink(join(values.record, "events.jsonl")));
    sinks.forEach((sink) => bus.addSink(sink));
    const signal = workerSignal();
    try {
      const game = await runGame({
        roomCode,
        roster,
        bus,
        signal: signal.signal,
        ...(values.record === undefined ? {} : {
          recordDir: values.record,
          credentialsFile: join(values.record, "credentials.json"),
        }),
      });
      live.printCosts(game);
    } finally {
      signal.dispose();
    }
  } finally {
    await closeSinks(bus, sinks, db);
  }
}

async function runWorkerLoop(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      room: { type: "string" },
      "room-file": { type: "string" },
      db: { type: "boolean" },
      ingest: { type: "string" },
    },
    strict: true,
  });
  const roomCode = required(values.room, "--room").toUpperCase();
  if (!process.env["OPENROUTER_API_KEY"]) throw new Error("OPENROUTER_API_KEY is not set");
  const roster = (await loadRoster()).models;
  const bus = new WorkerEventBus();
  compactLiveLog(bus);
  const sinks: WorkerSink[] = [];
  let db: ArenaDatabase | undefined;
  try {
    if (values.db) {
      db = await openDb();
    }
    const ingestUrl = values.ingest ?? process.env["WEB_INGEST_URL"];
    if (ingestUrl) sinks.push(new IngestSink({ url: ingestUrl }));
    sinks.forEach((sink) => bus.addSink(sink));
    const signal = workerSignal();
    try {
      await runLoop({
        roomCode,
        roster,
        bus,
        credentialsFile: DEFAULT_WORKER_CREDENTIALS,
        signal: signal.signal,
        ...(values["room-file"] === undefined ? {} : { roomFile: values["room-file"] }),
        ...(db === undefined ? {} : { db }),
      });
    } finally {
      signal.dispose();
    }
  } finally {
    await closeSinks(bus, sinks, db);
  }
}

async function runHostAgentCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "room-file": { type: "string" },
      "interval-s": { type: "string" },
      once: { type: "boolean" },
      image: { type: "string" },
    },
    strict: true,
  });
  const roomFile = required(values["room-file"], "--room-file");
  const intervalS = values["interval-s"] === undefined ? undefined : Number(values["interval-s"]);
  if (intervalS !== undefined && (!Number.isFinite(intervalS) || intervalS <= 0)) {
    throw new Error("--interval-s must be a positive number");
  }
  if (!process.env["OPENROUTER_API_KEY"]) throw new Error("OPENROUTER_API_KEY is not set");

  const signal = workerSignal();
  try {
    const result = await runHostAgent({
      roomFile,
      signal: signal.signal,
      ...(intervalS === undefined ? {} : { intervalS }),
      ...(values.once === undefined ? {} : { once: values.once }),
      ...(values.image === undefined ? {} : { image: values.image }),
    });
    if (values.once) {
      console.log(JSON.stringify({
        code: result.code,
        confirmed: result.confirmed,
        screenState: result.screenState,
      }));
      if (!result.confirmed) process.exitCode = 1;
    }
  } finally {
    signal.dispose();
  }
}

function scriptedRoster(count: number): RosterModel[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `scripted/player-${index + 1}`,
    displayName: `Script ${index + 1}`,
    lab: "Scripted",
    released: "2026-09-02",
    reasoning: null,
    temperature: null,
    enabled: true,
    rationale: "Local dry-run player",
  }));
}

function scriptedModelPlayer(entry: RosterModel, displayName: string): Player {
  const scripted = new ScriptedPlayer(displayName);
  return {
    name: scripted.name,
    modelId: entry.slug,
    answer: (prompt, ctx) => scripted.answer(prompt, ctx),
    answerFinal: (prompt, ctx) => scripted.answerFinal(prompt, ctx),
    vote: (prompt, options, ctx) => scripted.vote(prompt, options, ctx),
  };
}

async function runDryRun(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { players: { type: "string" } },
    strict: true,
  });
  const count = playerCount(values.players);
  const roster = scriptedRoster(count);
  const bus = new WorkerEventBus();
  const live = compactLiveLog(bus);
  const db = await openDb({ databaseUrl: null, dataDir: "memory://" });
  const sink = new DbSink(db);
  bus.addSink(sink);
  try {
    const game = await runGame({
      roomCode: "FAKE",
      roster,
      bus,
      gameClient: new FakeHarness({ playerCount: count }),
      playerFactory: scriptedModelPlayer,
      timeoutMs: 30_000,
    });
    const stored = await loadGame(db, game.id);
    if (!stored?.endedAt || stored.matchups.length !== count * 2 || !stored.thriplash) {
      throw new Error("Dry-run did not persist a complete game");
    }
    const ratings = await computeRatings(db, { bootstrapResamples: 0 });
    live.printCosts(game);
    console.log(`dry-run ok: ${stored.players.length} players, ${stored.matchups.length} matchups, ${ratings.populations.player.length} ratings`);
  } finally {
    await closeSinks(bus, [sink], db);
  }
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
    case "play":
      await runPlay(args);
      break;
    case "loop":
      await runWorkerLoop(args);
      break;
    case "host-agent":
      await runHostAgentCommand(args);
      break;
    case "dry-run":
      await runDryRun(args);
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
