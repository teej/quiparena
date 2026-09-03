#!/usr/bin/env node

import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { Game } from "@quiparena/core";
import { ScriptedPlayer, type Player, type PlayerContext } from "@quiparena/jackbox";
import { desc } from "drizzle-orm";

import { openDb, type ArenaDatabase } from "./db/client.js";
import {
  abandonGame,
  clearModelBenchState,
  loadModelBenchStates,
  syncRosterModels,
} from "./db/operations.js";
import { games } from "./db/schema.js";
import { runHostAgent } from "./host-agent/host-agent.js";
import { captureFinalScores } from "./host-agent/read-scores.js";
import type { LobbyGameHistory } from "./lobby.js";
import { ConsoleSink, ModelPlayer, type ModelPlayerConfig } from "./model-player.js";
import { computeRatings, leaderboard, type RatingPopulation } from "./ratings.js";
import { backfillAudienceVotes, loadGame } from "./recorder.js";
import { findRosterModel, loadRoster, validateRoster, type ModelRoster } from "./registry.js";
import type { RosterModel } from "./registry.js";
import { auditScoring, formatScoringAudit } from "./scoring-audit.js";
import { WorkerEventBus } from "./worker/bus.js";
import { CompactGameLogFormatter } from "./worker/compact-logger.js";
import { FakeHarness } from "./worker/fake-harness.js";
import { runGame } from "./worker/game-runner.js";
import { loadLobbyHistoryFromApi, runLoop } from "./worker/loop.js";
import { DbSink, IngestSink, JsonlSink, type WorkerSink } from "./worker/sinks.js";

function usage(): string {
  return [
    "Usage:",
    "  quiparena ask --model <slug> --prompt <text> [--deadline-s 30]",
    "  quiparena vote --model <slug> --prompt <text> --a <answer> --b <answer> [--deadline-s 30]",
    "  quiparena roster [unbench <slug>]",
    "  quiparena db migrate",
    "  quiparena ratings compute [--bootstrap 200] [--backfill-audience]",
    "  quiparena ratings show [--population blended]",
    "  quiparena scoring audit",
    "  quiparena games list [--limit 20]",
    "  quiparena games show <id>",
    "  quiparena games abandon <id>",
    "  quiparena games capture-scores <id> --image PATH [--model slug]",
    "  quiparena play --room CODE [--models slug,slug,...] [--players 8] [--answer-budget-s 15] [--vote-budget-s 10] [--record DIR] [--db] [--ingest URL]",
    "  quiparena loop --room CODE [--room-file PATH] [--answer-budget-s 15] [--vote-budget-s 10] [--db] [--ingest URL] [--stop-file PATH] [--max-games N]",
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

/** pnpm runs package scripts from the package dir; INIT_CWD is the operator's cwd. */
export function resolveOptionPath(value: string): string {
  return resolve(process.env["INIT_CWD"] ?? process.cwd(), value);
}

function deadlineMs(value: string | undefined): number {
  const seconds = value === undefined ? 30 : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--deadline-s must be a positive number");
  }
  return Date.now() + seconds * 1_000;
}

function optionalBudgetMs(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${flag} must be a positive number`);
  return Math.round(seconds * 1_000);
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
    ...(entry?.reasoningMandatory === undefined
      ? {}
      : { reasoningMandatory: entry.reasoningMandatory }),
    ...(entry?.reasoningPrompt === undefined ? {} : { reasoningPrompt: entry.reasoningPrompt }),
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
  const roster = await loadRoster();
  const [command, slug, ...extra] = args;
  if (command === "unbench") {
    if (!slug || extra.length > 0) throw new Error("Usage: quiparena roster unbench <slug>");
    if (!findRosterModel(roster, slug)) throw new Error(`Model is not in packages/arena/models.json: ${slug}`);
    await usingDb(async (db) => {
      await syncRosterModels(db, roster.models);
      await clearModelBenchState(db, slug);
    });
    console.log(`Cleared automatic bench state for ${slug}; enabled remains controlled by models.json.`);
    return;
  }
  parseArgs({ args, options: {}, strict: true });
  const report = await validateRoster(roster);
  const benchStates = await usingDb(loadModelBenchStates);
  console.log(`${roster.reviewStatus}; catalog checked ${roster.catalogCheckedAt}`);
  for (const entry of roster.models) {
    const unknown = report.unknown.includes(entry.slug);
    const unsupported = report.unsupported.find((item) => item.slug === entry.slug);
    const status = unknown ? "unknown" : unsupported ? "unsupported" : "ok";
    const benchState = benchStates.get(entry.slug);
    const suffix = [
      ...(unsupported ? [unsupported.reasons.join("; ")] : []),
      ...(benchState?.benched
        ? [`BENCHED (${benchState.gamesRemaining} games): ${benchState.reason ?? "automatic runtime bench"}`]
        : []),
      ...(!entry.enabled ? [`disabled manually: ${entry.disabledReason ?? "no reason"}`] : []),
    ];
    console.log(
      `[${status}] ${entry.slug} (${entry.displayName}, ${entry.released})`
      + (suffix.length === 0 ? "" : ` — ${suffix.join("; ")}`),
    );
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
      options: {
        bootstrap: { type: "string" },
        "backfill-audience": { type: "boolean" },
      },
      strict: true,
    });
    const bootstrapResamples = values.bootstrap === undefined ? undefined : Number(values.bootstrap);
    if (bootstrapResamples !== undefined
      && (!Number.isInteger(bootstrapResamples) || bootstrapResamples < 0)) {
      throw new Error("--bootstrap must be a non-negative integer");
    }
    await usingDb(async (db) => {
      if (values["backfill-audience"]) {
        const backfill = await backfillAudienceVotes(db);
        console.log(
          `Audience backfill examined ${backfill.observedMatchups} observed matchups:`
          + ` ${backfill.inferredVotes} inferred, ${backfill.countedVotes} counted.`,
        );
      }
      const result = await computeRatings(db, {
        ...(bootstrapResamples === undefined ? {} : { bootstrapResamples }),
      });
      console.log(`Computed ${result.method} ratings at ${result.computedAt}.`);
      for (const population of ["player", "audience", "blended"] as const) {
        console.log(`${population}: ${result.populations[population].length} models`);
      }
      const audit = await auditScoring(db);
      for (const game of audit.games) {
        if (game.maxFinalDelta === null) continue;
        console.log(`score validation: game=${game.gameId} max-delta=${game.maxFinalDelta}`);
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
          + `  games=${entry.stats.games} wins=${entry.stats.wins}`
          + ` avg-place=${entry.stats.avgPlacement?.toFixed(2) ?? "-"}`
          + ` avg-points=${entry.stats.avgPoints?.toFixed(0) ?? "-"}`,
        );
      }
    });
    return;
  }
  throw new Error("Usage: quiparena ratings <compute|show>");
}

async function runScoring(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command !== "audit") throw new Error("Usage: quiparena scoring audit");
  parseArgs({ args: rest, options: {}, strict: true });
  await usingDb(async (db) => {
    console.log(formatScoringAudit(await auditScoring(db)));
  });
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
  if (command === "abandon") {
    const [id, ...extra] = rest;
    if (!id || extra.length > 0) throw new Error("Usage: quiparena games abandon <id>");
    await usingDb(async (db) => {
      if (!await abandonGame(db, id)) throw new Error(`Game not found: ${id}`);
      console.log(`Abandoned game ${id}.`);
    });
    return;
  }
  if (command === "capture-scores") {
    const [id, ...options] = rest;
    if (!id) throw new Error("Usage: quiparena games capture-scores <id> --image PATH [--model slug]");
    const { values } = parseArgs({
      args: options,
      options: {
        image: { type: "string" },
        model: { type: "string" },
      },
      strict: true,
    });
    const image = resolveOptionPath(required(values.image, "--image"));
    if (!process.env["OPENROUTER_API_KEY"]) throw new Error("OPENROUTER_API_KEY is not set");
    await usingDb(async (db) => {
      const result = await captureFinalScores(db, id, image, {
        ...(values.model === undefined ? {} : { model: values.model }),
      });
      console.log(JSON.stringify(result, null, 2));
    });
    return;
  }
  throw new Error("Usage: quiparena games <list|show|abandon|capture-scores>");
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

function workerSignal(options: { onGracefulStop?: () => void } = {}): {
  signal: AbortSignal;
  stopRequested(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  let gracefulStop = false;
  const armGracefulStop = (): void => {
    if (gracefulStop) return;
    gracefulStop = true;
    options.onGracefulStop?.();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  if (options.onGracefulStop) process.once("SIGUSR1", armGracefulStop);
  return {
    signal: controller.signal,
    stopRequested: () => gracefulStop,
    dispose: () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
      process.off("SIGUSR1", armGracefulStop);
    },
  };
}

function compactLiveLog(bus: WorkerEventBus): {
  costs: Map<string, number>;
  printCosts(game: Game): void;
} {
  const formatter = new CompactGameLogFormatter();
  bus.on((event) => {
    for (const output of formatter.format(event)) {
      if (output.level === "error") console.error(output.text);
      else console.log(output.text);
    }
  });

  return {
    costs: formatter.costs,
    printCosts: (game) => {
      console.log("costs");
      for (const player of game.players) {
        const model = player.modelId ?? player.name;
        console.log(`  ${player.name}: $${(formatter.costs.get(model) ?? 0).toFixed(6)}`);
      }
      console.log(`  total: $${[...formatter.costs.values()].reduce((sum, value) => sum + value, 0).toFixed(6)}`);
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
      "answer-budget-s": { type: "string" },
      "vote-budget-s": { type: "string" },
    },
    strict: true,
  });
  const roomCode = required(values.room, "--room").toUpperCase();
  if (!process.env["OPENROUTER_API_KEY"]) throw new Error("OPENROUTER_API_KEY is not set");
  const roster = workerRoster(await loadRoster(), values.models, values.players);
  const recordDir = values.record === undefined ? undefined : resolveOptionPath(values.record);
  const answerBudgetMs = optionalBudgetMs(values["answer-budget-s"], "--answer-budget-s");
  const voteBudgetMs = optionalBudgetMs(values["vote-budget-s"], "--vote-budget-s");
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
    if (recordDir) sinks.push(new JsonlSink(join(recordDir, "events.jsonl")));
    sinks.forEach((sink) => bus.addSink(sink));
    const signal = workerSignal();
    try {
      const game = await runGame({
        roomCode,
        roster,
        bus,
        signal: signal.signal,
        ...(answerBudgetMs === undefined ? {} : { answerBudgetMs }),
        ...(voteBudgetMs === undefined ? {} : { voteBudgetMs }),
        ...(recordDir === undefined ? {} : {
          recordDir,
          credentialsFile: join(recordDir, "credentials.json"),
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
      "stop-file": { type: "string" },
      "max-games": { type: "string" },
      "answer-budget-s": { type: "string" },
      "vote-budget-s": { type: "string" },
    },
    strict: true,
  });
  const roomCode = required(values.room, "--room").toUpperCase();
  if (!process.env["OPENROUTER_API_KEY"]) throw new Error("OPENROUTER_API_KEY is not set");
  const roster = (await loadRoster()).models;
  const maxGames = values["max-games"] === undefined ? undefined : Number(values["max-games"]);
  const answerBudgetMs = optionalBudgetMs(values["answer-budget-s"], "--answer-budget-s");
  const voteBudgetMs = optionalBudgetMs(values["vote-budget-s"], "--vote-budget-s");
  if (maxGames !== undefined && (!Number.isInteger(maxGames) || maxGames < 1)) {
    throw new Error("--max-games must be a positive integer");
  }
  const bus = new WorkerEventBus();
  compactLiveLog(bus);
  const sinks: WorkerSink[] = [];
  let db: ArenaDatabase | undefined;
  const signal = workerSignal({
    onGracefulStop: () => {
      console.warn("[quiparena/worker] graceful stop armed by SIGUSR1; finishing the current game, sending NEW PLAYERS, then exiting");
    },
  });
  try {
    if (values.db) {
      db = await openDb();
    }
    const ingestUrl = values.ingest ?? process.env["WEB_INGEST_URL"];
    if (ingestUrl) sinks.push(new IngestSink({ url: ingestUrl }));
    let seedHistory: LobbyGameHistory[] | undefined;
    if (!db && ingestUrl) {
      try {
        seedHistory = await loadLobbyHistoryFromApi(ingestUrl, globalThis.fetch, signal.signal);
        console.log(`[quiparena/worker] seeded rotation from ${seedHistory.length} completed archive games`);
      } catch (error) {
        console.warn(
          `[quiparena/worker] could not seed rotation from archive API: `
          + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    sinks.forEach((sink) => bus.addSink(sink));
    await runLoop({
      roomCode,
      roster,
      bus,
      credentialsFile: DEFAULT_WORKER_CREDENTIALS,
      signal: signal.signal,
      stopRequested: signal.stopRequested,
      ...(answerBudgetMs === undefined ? {} : { answerBudgetMs }),
      ...(voteBudgetMs === undefined ? {} : { voteBudgetMs }),
      ...(values["room-file"] === undefined ? {} : { roomFile: resolveOptionPath(values["room-file"]) }),
      ...(values["stop-file"] === undefined ? {} : { stopFile: resolveOptionPath(values["stop-file"]) }),
      ...(maxGames === undefined ? {} : { maxGames }),
      ...(db === undefined ? {} : { db }),
      ...(seedHistory === undefined ? {} : { seedHistory }),
    });
  } finally {
    signal.dispose();
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
  const roomFile = resolveOptionPath(required(values["room-file"], "--room-file"));
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
      ...(values.image === undefined ? {} : { image: resolveOptionPath(values.image) }),
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
    case "scoring":
      await runScoring(args);
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
