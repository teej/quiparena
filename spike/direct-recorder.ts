/**
 * Emergency wire-level fallback for environments where macOS Seatbelt blocks
 * Chromium's MachPortRendezvousServer registration. recorder.ts remains the
 * requested Playwright implementation; this file lets the live game proceed.
 */
import WebSocket, { type RawData } from "ws";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOM = (process.env.ROOM_CODE ?? "BEXH").toUpperCase();
const HOST = "ecast-prod-use2.jackboxgames.com";
const NAMES = ["REC1", "REC2", "REC3", "REC4"];
const AVATARS = ["Purple", "Blue", "Teal", "Green"];
const OUT = `${resolve("spike/recordings")}/`;
const began = performance.now();
const stopAt = Date.now() + 22 * 60_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36";

type Json = Record<string, any>;
type Direction = "in" | "out";

mkdirSync(OUT, { recursive: true });

function t(): number {
  return Number((performance.now() - began).toFixed(3));
}

function event(name: string, details: Json = {}): void {
  const row = { t: t(), event: name, ...details };
  appendFileSync(`${OUT}events.jsonl`, `${JSON.stringify(row)}\n`);
  console.log(`[${(row.t / 1000).toFixed(1)}s] ${name}`, JSON.stringify(details));
}

function frame(player: string, dir: Direction, data: string): void {
  appendFileSync(`${OUT}${player}.jsonl`, `${JSON.stringify({ t: t(), dir, data })}\n`);
}

function roomInfo(code = ROOM): Json {
  try {
    const result = spawnSync("curl", ["-sS", `https://ecast.jackboxgames.com/api/v2/rooms/${code}`], {
      encoding: "utf8",
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function screen(label: string): void {
  const path = `${OUT}${label}.png`;
  const result = spawnSync("screencapture", ["-x", path], { encoding: "utf8" });
  event("screen", { label, path, ok: result.status === 0, error: result.stderr.trim() || undefined });
}

function promptText(blob: Json): string {
  const prompt = blob.prompt;
  if (typeof prompt === "string") return prompt.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!prompt) return "";
  return String(prompt.text ?? prompt.html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

class Client {
  readonly userId = crypto.randomUUID();
  readonly completed = new Set<string>();
  readonly scheduled = new Set<string>();
  ws?: WebSocket;
  id?: number;
  secret?: string;
  deviceId?: string;
  hostId = 1;
  seq = 0;
  room: Json = {};
  player: Json = {};
  active?: { fingerprint: string; state: string; began: number; blob: Json };
  joined?: Promise<void>;
  private resolveJoined?: () => void;
  private rejectJoined?: (error: Error) => void;

  constructor(readonly name: string) {}

  get blob(): Json {
    const { audience: _audience, ...room } = this.room;
    return { ...room, ...this.player };
  }

  connect(code = ROOM): Promise<void> {
    writeFileSync(`${OUT}${this.name}.jsonl`, "");
    const query = new URLSearchParams({
      role: "player",
      name: this.name,
      format: "json",
      "user-id": this.userId,
    });
    const url = `wss://${HOST}/api/v2/rooms/${code}/play?${query}`;
    event("websocket", { player: this.name, url, userId: this.userId, tvUuidEquivalent: this.userId });
    this.joined = new Promise<void>((resolve, reject) => {
      this.resolveJoined = resolve;
      this.rejectJoined = reject;
    });
    this.ws = new WebSocket(url, "ecast-v0", {
      origin: "https://jackbox.tv",
      headers: { "User-Agent": USER_AGENT },
    });
    this.ws.on("open", () => event("websocket-open", { player: this.name }));
    this.ws.on("message", (data, isBinary) => {
      const text = isBinary ? `base64:${Buffer.from(data as RawData).toString("base64")}` : data.toString();
      frame(this.name, "in", text);
      if (!isBinary) this.receive(text);
    });
    this.ws.on("unexpected-response", (_request, response) => {
      this.rejectJoined?.(new Error(`${this.name}: websocket HTTP ${response.statusCode}`));
    });
    this.ws.on("error", (error) => {
      event("websocket-error", { player: this.name, error: error.message });
      if (!this.id) this.rejectJoined?.(error);
    });
    this.ws.on("close", (code, reason) =>
      event("websocket-close", { player: this.name, code, reason: reason.toString() }),
    );
    return this.joined;
  }

  private receive(text: string): void {
    let message: Json;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (message.opcode === "client/welcome") {
      const welcome = message.result;
      this.id = welcome.id;
      this.secret = welcome.secret;
      this.deviceId = welcome.deviceId;
      const host = Object.values(welcome.here ?? {}).find((entry: any) => entry.roles?.host) as Json | undefined;
      if (host?.id) this.hostId = host.id;
      for (const [key, entity] of Object.entries(welcome.entities ?? {}) as Array<[string, any]>) {
        this.applyEntity(key, entity[0], entity[1]);
      }
      event("welcome", {
        player: this.name,
        id: this.id,
        name: welcome.name,
        secret: this.secret,
        deviceId: this.deviceId,
        reconnect: `${this.id}:player:${this.secret}`,
        here: welcome.here,
        profile: welcome.profile,
        entityKeys: Object.keys(welcome.entities ?? {}),
      });
      this.resolveJoined?.();
      return;
    }

    if (message.opcode === "object" || message.opcode === "text") {
      this.applyEntity(message.result.key, message.opcode, message.result);
    } else if (["client/kicked", "room/exit", "room/migrate"].includes(message.opcode)) {
      event("control-notification", { player: this.name, message });
    }
  }

  private applyEntity(key: string, opcode: string, result: Json): void {
    let value: Json;
    if (opcode === "object") value = result.val ?? {};
    else if (opcode === "text") {
      try {
        value = JSON.parse(result.val ?? result.text ?? "{}");
      } catch {
        value = { rawText: result.val ?? result.text };
      }
    } else return;

    if (key === "room" || key === "bc:room" || key === "roomBlob") this.room = value;
    if (key === "player" || key === `player:${this.id}` || key === `bc:customer:${this.userId}`) {
      this.player = value;
    }
    if (key === "room" || key === "bc:room" || key === "roomBlob" || key.startsWith("player") || key.startsWith("bc:customer")) {
      event("entity", {
        player: this.name,
        key,
        opcode,
        version: result.version,
        state: value.state,
        keys: Object.keys(value),
      });
      this.considerAction();
    }
  }

  send(opcode: string, params: Json): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error(`${this.name}: socket not open`);
    const data = JSON.stringify({ seq: ++this.seq, opcode, params });
    frame(this.name, "out", data);
    event("send", { player: this.name, data: JSON.parse(data) });
    this.ws.send(data);
  }

  mail(body: Json): void {
    this.send("client/send", { from: this.id, to: this.hostId, body });
  }

  chooseAvatar(name: string): void {
    this.mail({ action: "avatar", name });
  }

  private stateFingerprint(blob: Json): string {
    const state = String(blob.state ?? "");
    if (state === "EnterSingleText") return `${state}|${blob.entryId ?? ""}|${promptText(blob)}`;
    if (state === "EnterTextList") return `${state}|${blob.entryId ?? ""}|${promptText(blob)}`;
    if (state === "MakeSingleChoice") {
      return `${state}|${blob.choiceId ?? ""}|${promptText(blob)}|${JSON.stringify(blob.choices ?? [])}`;
    }
    return `${state}|${blob.lobbyState ?? ""}|${blob.message?.text ?? blob.message?.html ?? ""}`;
  }

  private considerAction(): void {
    const blob = this.blob;
    const state = String(blob.state ?? "");
    const fingerprint = this.stateFingerprint(blob);
    if (!this.active || this.active.fingerprint !== fingerprint) {
      if (this.active) {
        event("state-away", {
          player: this.name,
          state: this.active.state,
          fingerprint: this.active.fingerprint,
          durationMs: Number((t() - this.active.began).toFixed(3)),
        });
      }
      this.active = { fingerprint, state, began: t(), blob };
      event("state-appeared", {
        player: this.name,
        state,
        fingerprint,
        prompt: promptText(blob),
        blob,
      });
    }

    if (!["EnterSingleText", "EnterTextList", "MakeSingleChoice"].includes(state)) return;
    if (this.completed.has(fingerprint) || this.scheduled.has(fingerprint)) return;
    if (state === "EnterSingleText" && blob.entry) return;
    if (state === "EnterTextList" && blob.entries) return;
    if (state === "MakeSingleChoice" && blob.chosen) return;
    this.scheduled.add(fingerprint);
    setTimeout(() => {
      if (this.stateFingerprint(this.blob) !== fingerprint || this.completed.has(fingerprint)) return;
      try {
        this.act(this.blob, fingerprint);
        this.completed.add(fingerprint);
      } catch (error) {
        event("action-error", { player: this.name, error: String(error), blob: this.blob });
      }
    }, state === "MakeSingleChoice" ? 1_500 : 2_000);
  }

  private act(blob: Json, fingerprint: string): void {
    const ordinal = [...this.completed].filter((value) => value.startsWith("Enter")).length + 1;
    if (blob.state === "EnterSingleText") {
      const answer = `${this.name} quip ${ordinal}`;
      if (blob.textKey) this.send("text/update", { key: blob.textKey, val: answer });
      else this.mail({ action: "write", entry: answer });
      event("answer-submit", { player: this.name, fingerprint, answer, blob });
      return;
    }
    if (blob.state === "EnterTextList") {
      const answers = [1, 2, 3].map((index) => `${this.name} finale ${index}`);
      if (blob.textKey) this.send("text/update", { key: blob.textKey, val: answers.join("\n") });
      else this.mail({ action: "write", entries: answers });
      event("final-submit", { player: this.name, fingerprint, answers, blob });
      return;
    }
    if (blob.state === "MakeSingleChoice") {
      const choice = (blob.choices ?? []).find((candidate: Json) => !candidate.disabled);
      if (!choice) throw new Error("no enabled vote choice");
      const body = { action: choice.action ?? "choose", choice: choice.index };
      this.mail(body);
      event("vote-submit", { player: this.name, fingerprint, choice, body, blob });
    }
  }

  close(): void {
    this.ws?.close();
  }
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  writeFileSync(`${OUT}events.jsonl`, "");
  event("direct-recorder-start", { room: ROOM, playerNames: NAMES, wallClock: new Date().toISOString() });
  const initial = roomInfo();
  event("room-confirm", { response: initial });
  if (!initial.ok || initial.body?.appTag !== "quiplash3") throw new Error(`${ROOM} is not Quiplash 3`);

  const clients: Client[] = [];
  let phaseShot = 0;
  let lastStates = "";
  let lastScreen = 0;
  let newPlayersSent = false;
  try {
    for (let i = 0; i < NAMES.length; i += 1) {
      const client = new Client(NAMES[i]);
      clients.push(client);
      await client.connect();
      await new Promise((resolve) => setTimeout(resolve, 600));
      client.chooseAvatar(AVATARS[i]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await waitUntil(
      "four-player start permission",
      () => clients[0].player.playerIsVIP === true && clients[0].room.gameCanStart === true,
      30_000,
    );
    event("lobby-ready", { vipPlayer: clients[0].name, room: clients[0].room, player: clients[0].player });
    screen("lobby-four-players");
    clients[0].mail({ action: "start" });
    event("start-game", { player: clients[0].name });
    await waitUntil("game start transition", () => clients.some((client) => client.room.gameIsStarting === true || client.blob.state !== "Lobby"), 15_000);

    while (Date.now() < stopAt) {
      const states = clients.map((client) => client.blob.state ?? "closed").join("|");
      if (states !== lastStates) {
        event("global-states", { states });
        screen(`phase-${String(phaseShot++).padStart(3, "0")}`);
        lastStates = states;
      }
      if (Date.now() - lastScreen > 8_000) {
        screen(`periodic-${String(phaseShot++).padStart(3, "0")}`);
        lastScreen = Date.now();
      }

      const vip = clients[0];
      if (!newPlayersSent && vip.room.gameFinished === true && vip.player.playerIsVIP === true) {
        event("vip-postgame", { room: vip.room, player: vip.player });
        screen("game-ended-vip-menu");
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        vip.mail({ action: "PostGame_NewGame" });
        newPlayersSent = true;
        event("new-players-click", { player: vip.name, body: { action: "PostGame_NewGame" } });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!newPlayersSent) throw new Error("game never reached the VIP postgame menu");

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      event("after-new-players-poll", {
        attempt,
        api: roomInfo(),
        clients: clients.map((client) => ({
          player: client.name,
          readyState: client.ws?.readyState,
          roomState: client.room.state,
          playerState: client.player.state,
        })),
      });
    }
    screen("after-new-players");
    const oldRoom = roomInfo();
    const rejoinCode = oldRoom.ok && oldRoom.body?.appTag === "quiplash3" ? ROOM : "";
    event("room-code-result", { oldCode: ROOM, oldRoom, rejoinCode: rejoinCode || null });
    if (!rejoinCode) throw new Error("BEXH disappeared and screen capture is unavailable for reading a new code");

    for (const client of clients) client.close();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const rejoin = new Client("REJOIN1");
    await rejoin.connect(rejoinCode);
    await new Promise((resolve) => setTimeout(resolve, 750));
    rejoin.chooseAvatar("Purple");
    await waitUntil("rejoin lobby state", () => rejoin.player.state === "Lobby", 10_000);
    event("rejoin-proved", {
      code: rejoinCode,
      player: rejoin.name,
      id: rejoin.id,
      userId: rejoin.userId,
      room: rejoin.room,
      playerBlob: rejoin.player,
    });
    screen("after-rejoin");
    rejoin.close();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    event("complete", { rejoinCode });
  } catch (error) {
    event("fatal", { error: String(error), stack: error instanceof Error ? error.stack : undefined });
    screen("fatal");
    throw error;
  } finally {
    for (const client of clients) client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
