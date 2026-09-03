import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import WebSocket, { type RawData } from "ws";

const ROOM_FILE = resolve(
  process.env.ROOM_CODE_FILE ?? "packages/arena/.data/room-code",
);
const RECORDING_DIRECTORY = resolve(
  process.env.AUDIENCE_RECORDING_DIR ?? "spike/recordings",
);
const DIRECTORY_URL = "https://ecast.jackboxgames.com/api/v2/rooms";
const AUDIENCE_NAME = "AUDIENCE";
const POLL_INTERVAL_MS = 2_000;
const RETRY_INTERVAL_MS = 3_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 Chrome/151 Safari/537.36";

type JsonObject = Record<string, unknown>;

interface RoomInfo extends JsonObject {
  audienceEnabled?: boolean;
  audienceHost?: string;
  code?: string;
  moderationEnabled?: boolean;
}

interface AudienceCredentials {
  id: number;
  secret: string;
  deviceId?: string;
}

interface ActiveConnection {
  code: string;
  credentials?: AudienceCredentials;
  recordingPath: string;
  reconnectTimer?: NodeJS.Timeout;
  socket?: WebSocket;
  userId: string;
}

const RESULT_FIELD = /(vote|count|score|winner|winning|rank|standing|result|points|percent|total)/i;
const summaries = new Map<string, string>();
let active: ActiveConnection | undefined;
let stopping = false;

mkdirSync(RECORDING_DIRECTORY, { recursive: true });

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestampForFilename(): string {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

function cleanText(value: unknown): string | undefined {
  let text: unknown = value;
  if (isObject(value)) text = value.html ?? value.text;
  if (typeof text !== "string") return undefined;
  const cleaned = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_match, codePoint: string) => String.fromCodePoint(Number(codePoint)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function truncate(value: unknown, limit = 500): unknown {
  if (typeof value === "string") {
    return value.length > limit ? `${value.slice(0, limit)}...` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => truncate(item, limit));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).slice(0, 30).map(([key, item]) => [key, truncate(item, limit)]),
  );
}

function resultFields(value: unknown, path = "", depth = 0): JsonObject {
  if (depth > 5 || !isObject(value)) return {};
  const found: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const itemPath = path ? `${path}.${key}` : key;
    if (RESULT_FIELD.test(key)) found[itemPath] = truncate(item);
    if (key === "textDescriptions" && Array.isArray(item)) {
      const resultDescriptions = item.filter((description) => {
        if (!isObject(description)) return false;
        return RESULT_FIELD.test(String(description.category ?? "")) ||
          RESULT_FIELD.test(String(description.text ?? ""));
      });
      if (resultDescriptions.length > 0) found[itemPath] = truncate(resultDescriptions);
    }
    if (isObject(item)) Object.assign(found, resultFields(item, itemPath, depth + 1));
    if (Array.isArray(item)) {
      for (const [index, child] of item.entries()) {
        if (isObject(child)) Object.assign(found, resultFields(child, `${itemPath}[${index}]`, depth + 1));
      }
    }
  }
  return found;
}

function audienceProjection(key: string, value: unknown): unknown {
  if (!isObject(value)) return value;
  if (key === "audiencePlayer" && isObject(value.audience)) return value.audience;
  if ((key === "room" || key === "roomBlob" || key === "bc:room") && isObject(value.audience)) {
    return value.audience;
  }
  return value;
}

function choiceSummary(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((choice, index) => {
    if (!isObject(choice)) return truncate(choice, 160);
    return {
      id: choice.key ?? choice.index ?? index,
      text: cleanText(choice) ?? cleanText(choice.label) ?? cleanText(choice.value),
      ...(choice.disabled === undefined ? {} : { disabled: choice.disabled }),
    };
  });
}

function summarizeEntity(code: string, key: string, value: unknown, force = false): void {
  const projected = audienceProjection(key, value);
  const object = isObject(projected) ? projected : undefined;
  const summary: JsonObject = {
    key,
    ...(!object && projected !== undefined ? { value: truncate(projected) } : {}),
    ...(object?.state === undefined ? {} : { state: object.state }),
    ...(cleanText(object?.message) ? { message: cleanText(object?.message) } : {}),
    ...(cleanText(object?.prompt) ? { prompt: cleanText(object?.prompt) } : {}),
    ...(choiceSummary(object?.choices) ? { choices: choiceSummary(object?.choices) } : {}),
  };
  const results = resultFields(value);
  if (Object.keys(results).length > 0) summary.results = results;

  const notableKey = key.startsWith("bc:") || /(?:^|:)tv(?:$|:)/i.test(key) || /audience/i.test(key);
  const fingerprint = JSON.stringify(summary);
  const mapKey = `${code}:${key}`;
  if (!force && !notableKey && summaries.get(mapKey) === fingerprint) return;
  if (!force && !notableKey && object?.state === undefined && Object.keys(results).length === 0) return;
  if (!force && notableKey && summaries.get(mapKey) === fingerprint) return;
  summaries.set(mapKey, fingerprint);
  console.log(`[${new Date().toISOString()}] ${code} ${JSON.stringify(summary)}`);
}

function parseTextValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function applySnapshot(code: string, entities: unknown): void {
  if (!isObject(entities)) return;
  for (const [snapshotKey, tuple] of Object.entries(entities)) {
    if (!Array.isArray(tuple) || !isObject(tuple[1])) continue;
    const payload = tuple[1];
    const key = typeof payload.key === "string" ? payload.key : snapshotKey;
    const value = parseTextValue(payload.val ?? payload.count ?? payload);
    summarizeEntity(code, key, value, true);
  }
}

function inspectFrame(connection: ActiveConnection, raw: string): void {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    console.log(`[${new Date().toISOString()}] ${connection.code} non-JSON inbound frame`);
    return;
  }
  if (!isObject(frame)) return;

  if (frame.opcode === "client/welcome" && isObject(frame.result)) {
    const welcome = frame.result;
    if (typeof welcome.id === "number" && typeof welcome.secret === "string") {
      connection.credentials = {
        id: welcome.id,
        secret: welcome.secret,
        ...(typeof welcome.deviceId === "string" ? { deviceId: welcome.deviceId } : {}),
      };
    }
    console.log(`[${new Date().toISOString()}] ${connection.code} ${JSON.stringify({
      event: "welcome",
      id: welcome.id,
      name: welcome.name,
      reconnect: welcome.reconnect,
      profile: welcome.profile ?? null,
      entityKeys: isObject(welcome.entities) ? Object.keys(welcome.entities) : [],
    })}`);
    applySnapshot(connection.code, welcome.entities);
    return;
  }

  if (typeof frame.opcode === "string" && isObject(frame.result)) {
    const result = frame.result;
    if (frame.opcode === "audience/count-group") {
      console.log(`[${new Date().toISOString()}] ${connection.code} ${JSON.stringify({
        opcode: frame.opcode,
        key: result.key,
        choices: result.choices,
      })}`);
      return;
    }
    if (typeof result.key === "string") {
      summarizeEntity(connection.code, result.key, parseTextValue(result.val ?? result.count ?? result));
      return;
    }
    const suspicious = resultFields(result);
    if (Object.keys(suspicious).length > 0 || /audience|tv/i.test(frame.opcode)) {
      console.log(`[${new Date().toISOString()}] ${connection.code} ${JSON.stringify({
        opcode: frame.opcode,
        results: suspicious,
      })}`);
    }
  }
}

function recordInbound(connection: ActiveConnection, data: RawData, isBinary: boolean): void {
  const buffer = rawDataBuffer(data);
  const raw = isBinary
    ? `base64:${buffer.toString("base64")}`
    : buffer.toString("utf8");
  appendFileSync(
    connection.recordingPath,
    `${JSON.stringify({ t: Date.now(), dir: "in", data: raw })}\n`,
  );
  if (!isBinary) inspectFrame(connection, raw);
}

async function lookupRoom(code: string): Promise<RoomInfo> {
  const response = await fetch(`${DIRECTORY_URL}/${encodeURIComponent(code)}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  const decoded: unknown = await response.json();
  if (!response.ok || !isObject(decoded) || decoded.ok !== true || !isObject(decoded.body)) {
    throw new Error(`room lookup failed (${response.status}): ${JSON.stringify(decoded)}`);
  }
  return decoded.body as RoomInfo;
}

function audienceUrl(room: RoomInfo, connection: ActiveConnection): URL {
  if (!room.audienceEnabled) throw new Error(`room ${connection.code} does not enable audience`);
  if (!room.audienceHost) throw new Error(`room ${connection.code} has no audienceHost`);
  const url = new URL(
    `/api/v2/audience/${encodeURIComponent(connection.code)}/play`,
    `wss://${room.audienceHost}`,
  );
  url.searchParams.set("role", "audience");
  url.searchParams.set("name", AUDIENCE_NAME);
  url.searchParams.set("format", "json");
  url.searchParams.set("user-id", connection.userId);
  if (connection.credentials) {
    url.searchParams.set("id", String(connection.credentials.id));
    url.searchParams.set("secret", connection.credentials.secret);
    if (connection.credentials.deviceId) {
      url.searchParams.set("device-id", connection.credentials.deviceId);
    }
  }
  return url;
}

async function openSocket(connection: ActiveConnection): Promise<void> {
  if (stopping || active !== connection) return;
  const room = await lookupRoom(connection.code);
  if (active !== connection) return;
  const url = audienceUrl(room, connection);
  console.log(`[${new Date().toISOString()}] ${connection.code} ${JSON.stringify({
    event: "connecting",
    audienceHost: room.audienceHost,
    audienceEnabled: room.audienceEnabled,
    moderationEnabled: room.moderationEnabled,
    path: url.pathname,
    role: url.searchParams.get("role"),
    name: url.searchParams.get("name"),
    reconnect: Boolean(connection.credentials),
    recording: connection.recordingPath,
  })}`);

  const socket = new WebSocket(url, "ecast-v0", {
    origin: "https://jackbox.tv",
    headers: { Referer: "https://jackbox.tv/", "User-Agent": USER_AGENT },
  });
  connection.socket = socket;
  socket.on("open", () => {
    console.log(`[${new Date().toISOString()}] ${connection.code} websocket open (read-only)`);
  });
  socket.on("message", (data, isBinary) => recordInbound(connection, data, isBinary));
  socket.on("error", (error) => {
    console.error(`[${new Date().toISOString()}] ${connection.code} websocket error: ${error.message}`);
  });
  socket.on("unexpected-response", (_request, response) => {
    console.error(`[${new Date().toISOString()}] ${connection.code} websocket HTTP ${response.statusCode}`);
  });
  socket.on("close", (code, reason) => {
    if (connection.socket === socket) delete connection.socket;
    console.log(
      `[${new Date().toISOString()}] ${connection.code} websocket closed ${code} ${reason.toString()}`,
    );
    if (!stopping && active === connection) scheduleReconnect(connection);
  });
  // The recorder intentionally has no socket.send call. ws handles protocol-level pong frames.
}

function scheduleReconnect(connection: ActiveConnection): void {
  if (connection.reconnectTimer || stopping || active !== connection) return;
  connection.reconnectTimer = setTimeout(() => {
    delete connection.reconnectTimer;
    void openSocket(connection).catch((error: unknown) => {
      console.error(`[${new Date().toISOString()}] ${connection.code} reconnect failed: ${String(error)}`);
      scheduleReconnect(connection);
    });
  }, RETRY_INTERVAL_MS);
}

async function switchRoom(code: string): Promise<void> {
  const prior = active;
  if (prior?.code === code) return;
  if (prior?.reconnectTimer) clearTimeout(prior.reconnectTimer);
  if (prior?.socket && prior.socket.readyState < WebSocket.CLOSING) {
    prior.socket.close(1000, "room code changed");
  }

  const connection: ActiveConnection = {
    code,
    recordingPath: resolve(
      RECORDING_DIRECTORY,
      `audience-${code}-${timestampForFilename()}.jsonl`,
    ),
    userId: randomUUID(),
  };
  active = connection;
  console.log(
    `[${new Date().toISOString()}] watching ${basename(ROOM_FILE)} for room ${code}; ` +
      `recording ${connection.recordingPath}`,
  );
  await openSocket(connection);
}

async function readRoomCode(): Promise<string | undefined> {
  try {
    const code = (await readFile(ROOM_FILE, "utf8")).trim().toUpperCase();
    return /^[A-Z]{4}$/.test(code) ? code : undefined;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] cannot read ${ROOM_FILE}: ${String(error)}`);
    return undefined;
  }
}

async function pollRoomFile(): Promise<void> {
  const code = await readRoomCode();
  if (code && code !== active?.code) {
    try {
      await switchRoom(code);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${code} connect failed: ${String(error)}`);
      if (active?.code === code) scheduleReconnect(active);
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[${new Date().toISOString()}] ${signal}; stopping audience recorder`);
  if (active?.reconnectTimer) clearTimeout(active.reconnectTimer);
  if (active?.socket && active.socket.readyState < WebSocket.CLOSING) {
    await new Promise<void>((resolveClose) => {
      active?.socket?.once("close", () => resolveClose());
      active?.socket?.close(1000, "recorder stopping");
      setTimeout(resolveClose, 1_000).unref();
    });
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main(): Promise<void> {
  console.log(`[${new Date().toISOString()}] audience recorder starting; no game actions will be sent`);
  console.log(`[${new Date().toISOString()}] room file: ${ROOM_FILE}`);
  await pollRoomFile();
  setInterval(() => void pollRoomFile(), POLL_INTERVAL_MS);
}

void main().catch((error: unknown) => {
  console.error(`[${new Date().toISOString()}] fatal recorder error: ${String(error)}`);
  process.exitCode = 1;
});
