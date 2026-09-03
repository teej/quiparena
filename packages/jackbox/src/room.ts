const DEFAULT_DIRECTORY_URL = "https://ecast.jackboxgames.com/api/v2/rooms";

export interface RoomInfo {
  appId?: string;
  appTag?: string;
  audienceEnabled?: boolean;
  code: string;
  host: string;
  audienceHost?: string;
  locked?: boolean;
  full?: boolean;
  maxPlayers?: number;
  minPlayers?: number;
  moderationEnabled?: boolean;
  passwordRequired?: boolean;
  twitchLocked?: boolean;
  locale?: string;
  keepalive?: boolean;
  controllerBranch?: string;
  [key: string]: unknown;
}

export interface RoomLookupEnvelope {
  ok: boolean;
  body?: RoomInfo;
  error?: unknown;
}

export interface LookupRoomOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class RoomLookupError extends Error {
  readonly status?: number;
  readonly response?: unknown;

  constructor(message: string, options: { status?: number; response?: unknown } = {}) {
    super(message);
    this.name = "RoomLookupError";
    if (options.status !== undefined) this.status = options.status;
    if (options.response !== undefined) this.response = options.response;
  }
}

export async function lookupRoom(code: string, options: LookupRoomOptions = {}): Promise<RoomInfo> {
  const normalizedCode = code.trim().toUpperCase();
  if (!normalizedCode) throw new RoomLookupError("A room code is required");

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_DIRECTORY_URL).replace(/\/$/, "");
  const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(normalizedCode)}`, {
    // The production edge currently denies Node's default undici user-agent while
    // accepting the same request with curl's user-agent (also observed by the spike).
    headers: { Accept: "application/json", "User-Agent": "curl/8.7.1" },
  });

  const contentType = response.headers.get("content-type") ?? "";
  let decoded: unknown;
  try {
    decoded = contentType.includes("json") ? await response.json() : await response.text();
  } catch (error) {
    throw new RoomLookupError(`Room ${normalizedCode} returned an unreadable response`, {
      status: response.status,
      response: error,
    });
  }

  if (!response.ok) {
    throw new RoomLookupError(`Room ${normalizedCode} lookup failed with HTTP ${response.status}`, {
      status: response.status,
      response: decoded,
    });
  }

  if (!isRecord(decoded) || decoded.ok !== true || !isRecord(decoded.body)) {
    throw new RoomLookupError(`Room ${normalizedCode} was not found`, { response: decoded });
  }

  const body = decoded.body;
  if (typeof body.host !== "string" || !body.host) {
    throw new RoomLookupError(`Room ${normalizedCode} lookup did not include a play host`, {
      response: decoded,
    });
  }

  return { ...body, code: typeof body.code === "string" ? body.code.toUpperCase() : normalizedCode } as RoomInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
