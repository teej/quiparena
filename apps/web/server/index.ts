import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createQuipArenaServer } from "./server.js";

export async function main(): Promise<void> {
  const ingestToken = process.env["INGEST_TOKEN"];
  if (!ingestToken) throw new Error("INGEST_TOKEN is required");
  const port = Number(process.env["PORT"] ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  const service = createQuipArenaServer({ ingestToken });
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
