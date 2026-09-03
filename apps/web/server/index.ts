import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { openDb } from "@quiparena/arena";

import { DbStore } from "./db-store.js";
import { createQuipArenaServer } from "./server.js";
import { InMemoryStore, type Store } from "./store.js";

export async function main(): Promise<void> {
  const ingestToken = process.env["INGEST_TOKEN"];
  if (!ingestToken) throw new Error("INGEST_TOKEN is required");
  const port = Number(process.env["PORT"] ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  const databaseUrlSet = process.env["DATABASE_URL"] !== undefined;
  const databaseRequested = process.env["QUIPARENA_STORE"]?.trim().toLowerCase() === "db";
  let store: Store;
  if (databaseUrlSet || databaseRequested) {
    const db = await openDb();
    const dbStore = new DbStore(db);
    store = dbStore;
    // Housekeeping runs before live-state hydration so a stale game is never
    // restored as the current lobby after a restart.
    await dbStore.recomputeRatings().catch((error: unknown) => {
      console.error("QuipArena startup housekeeping failed", error);
    });
    const sweep = () => void dbStore.recomputeRatings().catch((error: unknown) => {
      console.error("QuipArena housekeeping failed", error);
    });
    setInterval(sweep, 5 * 60_000).unref();
    console.log(`QuipArena store: database (${db.$driver})`);
  } else {
    store = new InMemoryStore(true);
    console.log("QuipArena store: in-memory (demo seed)");
  }
  const service = createQuipArenaServer({ ingestToken, store });
  const address = await service.start(port, process.env["HOST"] ?? "127.0.0.1");
  console.log(`QuipArena web service listening on http://${address.address}:${address.port}`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
