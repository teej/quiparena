import { spawn } from "node:child_process";

import type { AnyEvent } from "@quiparena/core";
import { WebSocket } from "ws";

import { createDemoFixture } from "./demo.js";
import { createQuipArenaServer } from "./server.js";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function eventDelay(event: AnyEvent): number {
  switch (event.type) {
    case "thinking.delta": return 85;
    case "answer.draft":
    case "trace.completed": return 180;
    case "prompt.dealt": return 650;
    case "vote.requested":
    case "vote.cast": return 260;
    case "round.started": return 1_800;
    case "matchup.resolved":
    case "thriplash.resolved": return 2_400;
    default: return 420;
  }
}

function connect(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function main(): Promise<void> {
  const ingestToken = process.env["INGEST_TOKEN"] ?? "quiparena-demo";
  const port = Number(process.env["PORT"] ?? 8787);
  const service = createQuipArenaServer({ ingestToken });
  await service.start(port);

  const vite = spawn("vite", ["--host", "127.0.0.1"], {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: "inherit",
  });
  const stop = async (): Promise<void> => {
    vite.kill("SIGTERM");
    await service.close();
  };
  process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });

  console.log("Demo site: http://127.0.0.1:5173");
  await wait(900);
  const socket = await connect(`ws://127.0.0.1:${port}/ingest`, ingestToken);
  const fixture = createDemoFixture(20260903);
  for (const event of fixture.events) {
    socket.send(`${JSON.stringify(event)}\n`);
    await wait(eventDelay(event));
  }
  socket.close();
  console.log("Synthetic game complete. The demo site is still running; press Ctrl+C to stop.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
