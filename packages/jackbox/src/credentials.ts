import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SeatCredentials {
  room: string;
  name: string;
  userId: string;
  id: number;
  secret: string;
  /** Persisted by jackbox.tv for bundle selection, but not sent on the ecast URL. */
  branch?: string;
  /** QuipArena currently reconnects player seats only. */
  role?: "player";
  /** @deprecated Accepted from v1 files; reload reconnects deliberately do not preserve it. */
  deviceId?: string;
}

interface CredentialFileV2 {
  version: 2;
  seats: SeatCredentials[];
}

export async function saveCredentials(path: string, seats: readonly SeatCredentials[]): Promise<void> {
  const payload: CredentialFileV2 = { version: 2, seats: seats.map(credentialsForReload) };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function loadCredentials(path: string): Promise<SeatCredentials[]> {
  const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
  const candidates = isRecord(decoded) && Array.isArray(decoded.seats)
    ? decoded.seats
    : Array.isArray(decoded)
      ? decoded
      : [decoded];

  if (candidates.length === 0) throw new Error(`Credential file ${path} contains no seats`);
  return candidates.map((candidate, index) => parseCredentials(candidate, `${path} seat ${index + 1}`));
}

function parseCredentials(value: unknown, label: string): SeatCredentials {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  for (const field of ["room", "name", "userId", "secret"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`${label} has no valid ${field}`);
    }
  }
  if (!Number.isInteger(value.id) || (value.id as number) <= 0) {
    throw new Error(`${label} has no valid id`);
  }
  return credentialsForReload(value as unknown as SeatCredentials);
}

function credentialsForReload(credentials: SeatCredentials): SeatCredentials {
  return {
    room: credentials.room.trim().toUpperCase(),
    name: credentials.name,
    userId: credentials.userId,
    id: credentials.id,
    secret: credentials.secret,
    ...(credentials.branch ? { branch: credentials.branch } : {}),
    role: "player",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
