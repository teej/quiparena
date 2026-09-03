import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SeatCredentials {
  room: string;
  name: string;
  userId: string;
  deviceId: string;
  id: number;
  secret: string;
}

interface CredentialFileV1 {
  version: 1;
  seats: SeatCredentials[];
}

export async function saveCredentials(path: string, seats: readonly SeatCredentials[]): Promise<void> {
  const payload: CredentialFileV1 = { version: 1, seats: seats.map(normalizeCredentials) };
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
  for (const field of ["room", "name", "userId", "deviceId", "secret"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`${label} has no valid ${field}`);
    }
  }
  if (!Number.isInteger(value.id) || (value.id as number) <= 0) {
    throw new Error(`${label} has no valid id`);
  }
  return normalizeCredentials(value as unknown as SeatCredentials);
}

function normalizeCredentials(credentials: SeatCredentials): SeatCredentials {
  return {
    room: credentials.room.trim().toUpperCase(),
    name: credentials.name,
    userId: credentials.userId,
    deviceId: credentials.deviceId,
    id: credentials.id,
    secret: credentials.secret,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
