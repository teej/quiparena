#!/usr/bin/env node

import { parseArgs } from "node:util";
import { join, resolve } from "node:path";

import type { AnyEvent } from "@quiparena/core";

import { GameAggregator } from "./aggregator.js";
import { loadCredentials, saveCredentials, type SeatCredentials } from "./credentials.js";
import { EcastConnection } from "./ecast.js";
import { Quiplash3Seat } from "./quiplash3.js";
import { replayDirectory, type ReplayCount, type ReplayOccurrence } from "./replay.js";
import { lookupRoom, type RoomInfo } from "./room.js";
import { ScriptedPlayer } from "./scripted-player.js";

function usage(): never {
  console.error([
    "Usage:",
    "  pnpm --filter @quiparena/jackbox lookup --room CODE",
    "  pnpm --filter @quiparena/jackbox play --room CODE --players N [--record DIR] [--credentials FILE]",
    "  pnpm --filter @quiparena/jackbox reconnect --credentials FILE",
    "  pnpm --filter @quiparena/jackbox replay --dir DIR [--player-delay-ms N]",
  ].join("\n"));
  process.exit(2);
}

function roomOption(values: { room?: string }): string {
  if (!values.room) usage();
  return values.room.toUpperCase();
}

function assertQuiplash3(room: RoomInfo): void {
  if (room.appTag !== "quiplash3" && room.appTag !== "quiplash3-tjsp") {
    throw new Error(`Room ${room.code} is ${String(room.appTag)}, not Quiplash 3`);
  }
}

async function lookupCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { room: { type: "string" } },
    strict: true,
  });
  console.log(JSON.stringify(await lookupRoom(roomOption(values)), null, 2));
}

async function playCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      room: { type: "string" },
      players: { type: "string" },
      record: { type: "string" },
      credentials: { type: "string" },
    },
    strict: true,
  });
  const room = await lookupRoom(roomOption(values));
  assertQuiplash3(room);
  const playerCount = Number(values.players);
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > (room.maxPlayers ?? 8)) {
    throw new Error(`--players must be an integer from 1 to ${room.maxPlayers ?? 8}`);
  }
  if (room.locked) throw new Error(`Room ${room.code} is locked`);
  if (room.full) throw new Error(`Room ${room.code} is full`);
  const recordDir = values.record ? resolveOptionPath(values.record) : undefined;
  const credentialsFile = values.credentials ? resolveOptionPath(values.credentials) : undefined;

  const gameId = `${room.code}-${Date.now()}`;
  const aggregator = new GameAggregator({ gameId, expectedPlayerCount: playerCount, onEvent: printEvent });
  const onSeatEvent = (event: AnyEvent): void => {
    if (event.type !== "game.ended") printEvent(event);
    aggregator.ingest(event);
  };
  const seats: Quiplash3Seat[] = [];
  const saved: SeatCredentials[] = [];
  const signal = signalPromise();
  try {
    // Sequential joins let each successful avatar update reach the next seat before
    // it selects from room.characters, avoiding same-character races.
    for (let index = 0; index < playerCount; index += 1) {
      const name = `QA${index + 1}`;
      const player = new ScriptedPlayer(name, { voteOffset: index });
      const connection = new EcastConnection({
        room,
        name,
        ...(recordDir ? { recordFile: join(recordDir, `${name}.jsonl`) } : {}),
      });
      const seat = new Quiplash3Seat(connection, player, {
        gameId,
        postGameAction: "newPlayers",
        onEvent: onSeatEvent,
      });
      seats.push(seat);
      await seat.connect();
      const credentials = connection.credentials;
      if (!credentials) throw new Error(`${name} connected without reconnect credentials`);
      saved.push(credentials);
      if (credentialsFile) await saveCredentials(credentialsFile, saved);
      await seat.waitUntilAvatarSelected();
    }

    const vip = seats[0];
    if (!vip) throw new Error("No player seats were created");
    await vip.waitUntilCanStart();
    if (!await vip.startIfVip()) {
      throw new Error("The first joined seat is not the start-capable VIP");
    }

    const game = Promise.all(seats.map((seat) => seat.waitForGameEnd())).then(() => "game" as const);
    const outcome = await Promise.race([game, signal.promise]);
    if (outcome !== "game") process.exitCode = 130;
  } finally {
    signal.dispose();
    await Promise.allSettled(seats.map((seat) => seat.close()));
  }
}

async function reconnectCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { credentials: { type: "string" } },
    strict: true,
  });
  if (!values.credentials) usage();
  const credentials = await loadCredentials(resolveOptionPath(values.credentials));
  const rooms = new Map<string, RoomInfo>();
  const seats: Quiplash3Seat[] = [];
  const gameId = `${credentials[0]?.room ?? "ROOM"}-reconnect-${Date.now()}`;
  const aggregator = new GameAggregator({
    gameId,
    expectedPlayerCount: credentials.length,
    onEvent: printEvent,
  });
  const onSeatEvent = (event: AnyEvent): void => {
    if (event.type !== "game.ended") printEvent(event);
    aggregator.ingest(event);
  };
  const signal = signalPromise();
  try {
    for (const saved of credentials) {
      let room = rooms.get(saved.room);
      if (!room) {
        room = await lookupRoom(saved.room);
        assertQuiplash3(room);
        rooms.set(saved.room, room);
      }
      const player = new ScriptedPlayer(saved.name, { voteOffset: saved.id });
      const connection = new EcastConnection({ room, name: saved.name, credentials: saved });
      const seat = new Quiplash3Seat(connection, player, {
        gameId,
        postGameAction: "none",
        onEvent: onSeatEvent,
      });
      seats.push(seat);
      const welcome = await seat.connect();
      console.log(JSON.stringify({ type: "seat.reclaimed", room: saved.room, name: welcome.name, id: welcome.id }));
    }

    const game = Promise.all(seats.map((seat) => seat.waitForGameEnd())).then(() => "game" as const);
    const outcome = await Promise.race([game, signal.promise]);
    if (outcome !== "game") process.exitCode = 130;
  } finally {
    signal.dispose();
    await Promise.allSettled(seats.map((seat) => seat.close()));
  }
}

async function replayCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      "player-delay-ms": { type: "string" },
    },
    strict: true,
  });
  if (!values.dir) usage();
  const playerDelayMs = Number(values["player-delay-ms"] ?? 0);
  if (!Number.isFinite(playerDelayMs) || playerDelayMs < 0) {
    throw new RangeError("--player-delay-ms must be a non-negative number");
  }
  const reports = await replayDirectory(resolveOptionPath(values.dir), { playerDelayMs });
  for (const report of reports) {
    console.log([
      report.seat,
      `states seen: ${formatCounts(report.statesSeen)}`,
      `actions sent: ${formatCounts(report.actionsSent)}`,
      `missed states: ${formatOccurrences(report.missedStates)}`,
      `extra actions: ${formatOccurrences(report.extraActions)}`,
      `unassigned actions: ${report.unassignedActions}`,
    ].join(" | "));
  }
  if (reports.some((report) => !report.ok)) process.exitCode = 1;
}

function signalPromise(): {
  promise: Promise<"signal">;
  dispose: () => void;
} {
  let resolve!: (value: "signal") => void;
  const promise = new Promise<"signal">((done) => {
    resolve = done;
  });
  const handler = (): void => resolve("signal");
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return {
    promise,
    dispose: () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}

function printEvent(event: AnyEvent): void {
  console.log(JSON.stringify(event));
}

function resolveOptionPath(path: string): string {
  return resolve(process.env.INIT_CWD || process.cwd(), path);
}

function formatCounts(counts: ReplayCount): string {
  return `EnterSingleText=${counts.EnterSingleText}, EnterTextList=${counts.EnterTextList}, MakeSingleChoice=${counts.MakeSingleChoice}`;
}

function formatOccurrences(occurrences: readonly ReplayOccurrence[]): string {
  if (occurrences.length === 0) return "none";
  return occurrences.map((occurrence) => {
    const version = occurrence.version === undefined ? "" : ` v${occurrence.version}`;
    return `${occurrence.state}${version} (${JSON.stringify(occurrence.prompt)}) x${occurrence.actionsSent}`;
  }).join(", ");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "lookup":
      await lookupCommand(args);
      break;
    case "play":
      await playCommand(args);
      break;
    case "reconnect":
      await reconnectCommand(args);
      break;
    case "replay":
      await replayCommand(args);
      break;
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
