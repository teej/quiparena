import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";

import { schema } from "./schema.js";

export type DatabaseDriver = "postgres" | "pglite";

/** The common Drizzle Postgres surface exposed by both supported drivers. */
export type ArenaDatabaseClient = PgDatabase<any, typeof schema>;

/** A database opened here also carries its driver identity and lifecycle hook. */
export type ArenaDatabase = ArenaDatabaseClient & {
  readonly $client: Sql | PGlite;
  readonly $driver: DatabaseDriver;
  close(): Promise<void>;
};

export interface OpenDbOptions {
  /** Override DATABASE_URL. Pass null to force PGlite. */
  databaseUrl?: string | null;
  /** PGlite data directory. Use "memory://" for tests. */
  dataDir?: string;
  /** An existing PGlite instance, primarily for tests. */
  pglite?: PGlite;
  migrationsFolder?: string;
}

export const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../.data/quiparena", import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

function decorate(
  database: ArenaDatabaseClient & { $client: Sql | PGlite },
  driver: DatabaseDriver,
  close: () => Promise<void>,
): ArenaDatabase {
  Object.defineProperties(database, {
    $driver: { value: driver, enumerable: true },
    close: { value: close, enumerable: false },
  });
  return database as ArenaDatabase;
}

/** Open the configured database and apply every pending Drizzle migration. */
export async function openDb(options: OpenDbOptions = {}): Promise<ArenaDatabase> {
  const databaseUrl = options.databaseUrl === undefined
    ? process.env["DATABASE_URL"]?.trim() || null
    : options.databaseUrl?.trim() || null;
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_DIR;

  if (databaseUrl) {
    const [{ default: postgres }, { drizzle }, { migrate }] = await Promise.all([
      import("postgres"),
      import("drizzle-orm/postgres-js"),
      import("drizzle-orm/postgres-js/migrator"),
    ]);
    const client = postgres(databaseUrl, { max: 5 });
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
    } catch (error) {
      await client.end();
      throw error;
    }
    return decorate(database, "postgres", () => client.end());
  }

  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  if (!options.pglite && dataDir !== "memory://") await mkdir(dirname(dataDir), { recursive: true });
  const client = options.pglite ?? new PGlite(dataDir);
  const database = drizzle(client, { schema });
  try {
    await migrate(database, { migrationsFolder });
  } catch (error) {
    await client.close();
    throw error;
  }
  return decorate(database, "pglite", () => client.close());
}
