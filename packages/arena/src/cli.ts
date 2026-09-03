#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { PlayerContext } from "@quiparena/jackbox";

import { ConsoleSink, ModelPlayer, type ModelPlayerConfig } from "./model-player.js";
import { findRosterModel, loadRoster, validateRoster, type ModelRoster } from "./registry.js";

function usage(): string {
  return [
    "Usage:",
    "  quiparena ask --model <slug> --prompt <text> [--deadline-s 30]",
    "  quiparena vote --model <slug> --prompt <text> --a <answer> --b <answer> [--deadline-s 30]",
    "  quiparena roster",
    "",
    "From the workspace:",
    "  pnpm --filter @quiparena/arena ask --model <slug> --prompt <text>",
  ].join("\n");
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
