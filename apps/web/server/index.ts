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
  const requestedStore = process.env["QUIPARENA_STORE"]?.trim().toLowerCase() || undefined;
  if (requestedStore !== undefined && requestedStore !== "db" && requestedStore !== "memory") {
    throw new Error("QUIPARENA_STORE must be either db or memory");
  }
  const databaseUrlSet = process.env["DATABASE_URL"] !== undefined;
  const databaseRequested = requestedStore === "db"
    || (requestedStore === undefined && databaseUrlSet);
  let store: Store;
  let closeDatabase: (() => Promise<void>) | undefined;
  let housekeeping: ReturnType<typeof setInterval> | undefined;
  if (databaseRequested) {
    const db = await openDb();
    closeDatabase = () => db.close();
    const dbStore = new DbStore(db);
    store = dbStore;
    // Housekeeping runs before live-state hydration so a stale game is never
    // restored as the current lobby after a restart.
    await dbStore.recomputeRatings().catch((error: unknown) => {
      console.error("QuipArena startup housekeeping failed", error);
    });
    const sweep = () => void dbStore.recomputeRatings().then(async () => {
      // PGlite has no background checkpointer. Persist a recovery point while
      // the long-running game loop is active, as well as on clean shutdown.
      if (db.$driver === "pglite" && "exec" in db.$client) await db.$client.exec("CHECKPOINT");
    }).catch((error: unknown) => {
      console.error("QuipArena housekeeping failed", error);
    });
    housekeeping = setInterval(sweep, 5 * 60_000);
    housekeeping.unref();
    console.log(`QuipArena store: database (${db.$driver})`);
  } else {
    store = new InMemoryStore(true);
    console.log("QuipArena store: in-memory (demo seed)");
  }
  const service = createQuipArenaServer({ ingestToken, store });
  const address = await service.start(port, process.env["HOST"] ?? "127.0.0.1");
  console.log(`QuipArena web service listening on http://${address.address}:${address.port}`);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(housekeeping);
    try {
      await service.close();
      await closeDatabase?.();
    } catch (error) {
      console.error("QuipArena shutdown failed", error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
