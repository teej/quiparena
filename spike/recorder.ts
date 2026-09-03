import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOM = (process.env.ROOM_CODE ?? "BEXH").toUpperCase();
const PLAYERS = ["REC1", "REC2", "REC3", "REC4"];
const OUT = `${resolve("spike/recordings")}/`;
const startedAt = performance.now();
const deadlineAt = Date.now() + 22 * 60_000;

type Direction = "in" | "out";
type Player = {
  name: string;
  context: BrowserContext;
  page: Page;
  promptStarted: Map<string, number>;
  voteStarted: Map<string, number>;
  answered: Set<string>;
  voted: Set<string>;
  lastSummary: string;
};

mkdirSync(OUT, { recursive: true });

function t(): number {
  return Number((performance.now() - startedAt).toFixed(3));
}

function event(eventName: string, details: Record<string, unknown> = {}): void {
  const row = { t: t(), event: eventName, ...details };
  appendFileSync(`${OUT}events.jsonl`, `${JSON.stringify(row)}\n`);
  console.log(`[${(row.t / 1000).toFixed(1)}s] ${eventName}`, JSON.stringify(details));
}

function frameData(payload: string | Buffer): string {
  return Buffer.isBuffer(payload) ? `base64:${payload.toString("base64")}` : payload;
}

function recordFrame(name: string, dir: Direction, payload: string | Buffer): void {
  appendFileSync(
    `${OUT}${name}.jsonl`,
    `${JSON.stringify({ t: t(), dir, data: frameData(payload) })}\n`,
  );
}

function screen(label: string): string {
  const path = `${OUT}${label}.png`;
  const result = spawnSync("screencapture", ["-x", path], { encoding: "utf8" });
  event("screen", {
    label,
    path,
    ok: result.status === 0,
    error: result.stderr?.trim() || undefined,
  });
  return path;
}

async function roomInfo(code: string): Promise<Record<string, unknown>> {
  try {
    // The API's edge occasionally serves an HTML denial to Node's fetch while
    // accepting curl from the same machine, so use the same proven client as
    // the task's preflight command.
    const response = spawnSync(
      "curl",
      ["-sS", `https://ecast.jackboxgames.com/api/v2/rooms/${code}`],
      { encoding: "utf8" },
    );
    if (response.status !== 0) throw new Error(response.stderr.trim() || `curl exited ${response.status}`);
    return JSON.parse(response.stdout) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function visibleText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
}

async function dump(player: Player, label: string): Promise<void> {
  const safe = `${player.name}-${label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`;
  writeFileSync(`${OUT}${safe}.html`, await player.page.content().catch(() => ""));
  await player.page.screenshot({ path: `${OUT}${safe}.png`, fullPage: true }).catch(() => {});
  event("dom-dump", { player: player.name, label, body: (await visibleText(player.page)).slice(0, 2_000) });
}

async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = matches.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ timeout: 3_000 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

async function attachPlayer(browser: Browser, name: string, code: string): Promise<Player> {
  writeFileSync(`${OUT}${name}.jsonl`, "");
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  const page = await context.newPage();
  const player: Player = {
    name,
    context,
    page,
    promptStarted: new Map(),
    voteStarted: new Map(),
    answered: new Set(),
    voted: new Set(),
    lastSummary: "",
  };

  page.on("websocket", (ws) => {
    event("websocket", { player: name, url: ws.url() });
    ws.on("framesent", ({ payload }) => recordFrame(name, "out", payload));
    ws.on("framereceived", ({ payload }) => recordFrame(name, "in", payload));
    ws.on("close", () => event("websocket-close", { player: name, url: ws.url() }));
    ws.on("socketerror", (error) => event("websocket-error", { player: name, error }));
  });
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      event("browser-console", { player: name, type: message.type(), text: message.text().slice(0, 1_000) });
    }
  });
  page.on("pageerror", (error) => event("page-error", { player: name, error: String(error) }));

  event("navigate", { player: name, code });
  await page.goto("https://jackbox.tv", { waitUntil: "domcontentloaded", timeout: 30_000 });

  const roomInput = page.locator("#roomcode, input[name='roomcode'], input[placeholder*='room' i]").first();
  const nameInput = page.locator("#username, input[name='username'], input[placeholder*='name' i]").first();
  await nameInput.waitFor({ state: "visible", timeout: 20_000 });
  // Entering the room last makes jackbox.tv perform its room lookup.
  await nameInput.fill(name);
  await roomInput.fill(code);
  await page.waitForTimeout(1_000);
  const beforeJoin = (await visibleText(page)).slice(0, 1_500);
  event("join-form", { player: name, body: beforeJoin });

  const joined = await clickFirstVisible(page, [
    "#button-join:not([disabled])",
    "button:has-text('Play')",
    "button:has-text('Join')",
  ]);
  if (!joined) throw new Error(`${name}: could not find the join button`);

  await page.waitForTimeout(1_500);
  const avatarClicked = await clickFirstVisible(page, [
    ".characters:not(.disabled)",
    ".character:not(.disabled)",
    "button[class*='character']:not([disabled])",
    "button:has-text('Choose')",
  ]);
  event("avatar", { player: name, clicked: avatarClicked });
  await page.waitForTimeout(1_500);

  const storage = await page.evaluate(() => ({
    uuid: localStorage.getItem("tv:uuid"),
    entries: Object.fromEntries(Object.entries(localStorage)),
  }));
  event("joined", {
    player: name,
    url: page.url(),
    storage,
    body: (await visibleText(page)).slice(0, 2_000),
  });
  return player;
}

async function textOf(page: Page, selector: string): Promise<string> {
  const loc = page.locator(selector).filter({ visible: true }).first();
  return (await loc.innerText({ timeout: 500 }).catch(() => "")).trim();
}

async function visibleButtons(page: Page): Promise<Array<{ index: number; text: string }>> {
  const buttons = page.locator("button, .button");
  const result: Array<{ index: number; text: string }> = [];
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const text = (await button.innerText().catch(() => "")).trim();
    result.push({ index: i, text });
  }
  return result;
}

function answerFor(player: Player, ordinal: number): string {
  return `${player.name} quip ${ordinal}`;
}

function finalAnswerFor(player: Player, ordinal: number): string {
  return `${player.name} finale ${ordinal}`;
}

async function submitPrompt(player: Player, fingerprint: string): Promise<boolean> {
  const page = player.page;
  const fields = page.locator("textarea:visible, #input-text-textarea:visible, input[type='text']:visible");
  const count = await fields.count().catch(() => 0);
  if (count === 0) return false;

  const isFinal = /final prompt/i.test(fingerprint) || count >= 3;
  if (isFinal) {
    const limit = Math.min(3, count);
    for (let i = 0; i < limit; i += 1) {
      await fields.nth(i).fill(finalAnswerFor(player, i + 1));
    }
  } else {
    await fields.first().fill(answerFor(player, player.answered.size + 1));
  }

  const buttons = await visibleButtons(page);
  const preferred = buttons.find((button) => /submit|send|enter/i.test(button.text));
  const chosen = preferred ?? buttons[0];
  if (!chosen) return false;
  await page.locator("button, .button").nth(chosen.index).click({ timeout: 3_000 });
  event("answer-submit", {
    player: player.name,
    fingerprint,
    final: isFinal,
    values: await fields.evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value)),
    button: chosen.text,
  });
  return true;
}

async function maybeAct(player: Player): Promise<{ prompt: boolean; vote: boolean; final: boolean }> {
  const page = player.page;
  const header = await textOf(page, "#prompt .header, [class*='prompt'] [class*='header']");
  const promptArea = await textOf(page, "#prompt, [id*='prompt']");
  const body = await visibleText(page);
  const buttons = await visibleButtons(page);
  const summary = JSON.stringify({ header, promptArea: promptArea.slice(0, 400), buttons: buttons.map((b) => b.text) });
  if (summary !== player.lastSummary) {
    event("ui", { player: player.name, header, prompt: promptArea.slice(0, 1_000), buttons: buttons.map((b) => b.text), body: body.slice(0, 1_000) });
    player.lastSummary = summary;
  }

  const isFinal = /final prompt/i.test(header) || /final prompt/i.test(promptArea);
  const isPrompt = /prompt\s+[12]\s+of\s+2/i.test(header) || isFinal;
  const question = promptArea.replace(/\s+/g, " ").trim();
  const promptFingerprint = `${header}|${question}`;

  for (const [active, began] of player.promptStarted) {
    if (active !== promptFingerprint && !question.includes(active.split("|")[1] || "__never__")) {
      event("prompt-away", { player: player.name, fingerprint: active, durationMs: Number((t() - began).toFixed(3)) });
      player.promptStarted.delete(active);
    }
  }

  if (isPrompt && question) {
    if (!player.promptStarted.has(promptFingerprint)) {
      player.promptStarted.set(promptFingerprint, t());
      event("prompt-appeared", { player: player.name, header, question });
    }
    if (!player.answered.has(promptFingerprint) && t() - (player.promptStarted.get(promptFingerprint) ?? t()) > 2_000) {
      if (await submitPrompt(player, promptFingerprint)) player.answered.add(promptFingerprint);
    }
  }

  const voteInstruction = /vote for your favorite/i.test(`${header} ${promptArea} ${body.slice(0, 800)}`);
  const voteOptions = buttons.filter((button) =>
    button.text && !/submit|same players|new players|everybody|censor|back/i.test(button.text)
  );
  const voteFingerprint = `${question}|${voteOptions.map((option) => option.text).join("|")}`;

  for (const [active, began] of player.voteStarted) {
    if (active !== voteFingerprint) {
      event("vote-away", { player: player.name, fingerprint: active, durationMs: Number((t() - began).toFixed(3)) });
      player.voteStarted.delete(active);
    }
  }

  if (voteInstruction && voteOptions.length >= 2) {
    if (!player.voteStarted.has(voteFingerprint)) {
      player.voteStarted.set(voteFingerprint, t());
      event("vote-appeared", { player: player.name, question, options: voteOptions.map((option) => option.text) });
    }
    if (!player.voted.has(voteFingerprint) && t() - (player.voteStarted.get(voteFingerprint) ?? t()) > 1_500) {
      const pick = voteOptions[0];
      await page.locator("button, .button").nth(pick.index).click({ timeout: 3_000 });
      player.voted.add(voteFingerprint);
      event("vote-submit", { player: player.name, fingerprint: voteFingerprint, option: pick.text });
    }
  }

  return { prompt: isPrompt, vote: voteInstruction, final: isFinal };
}

async function startGame(vip: Player): Promise<void> {
  const page = vip.page;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const buttons = await visibleButtons(page);
    const start = buttons.find((button) => /everybody.?s in/i.test(button.text));
    if (start) {
      event("start-game", { player: vip.name, button: start.text });
      await page.locator("button, .button").nth(start.index).click();
      return;
    }
    await page.waitForTimeout(500);
  }
  await dump(vip, "missing-everybodys-in");
  throw new Error("VIP could not find Everybody's in");
}

async function waitForEnd(players: Player[]): Promise<void> {
  let lastProgress = Date.now();
  let lastCapture = 0;
  let captureIndex = 0;
  let lastGlobal = "";
  while (Date.now() < deadlineAt) {
    let anyPrompt = false;
    let anyVote = false;
    let anyFinal = false;
    for (const player of players) {
      const before = player.answered.size + player.voted.size;
      const state = await maybeAct(player).catch(async (error) => {
        event("act-error", { player: player.name, error: String(error) });
        await dump(player, "act-error");
        return { prompt: false, vote: false, final: false };
      });
      anyPrompt ||= state.prompt;
      anyVote ||= state.vote;
      anyFinal ||= state.final;
      if (player.answered.size + player.voted.size > before) lastProgress = Date.now();
    }

    const vipBody = await visibleText(players[0].page);
    if (/what do you want to do/i.test(vipBody) && /new players/i.test(vipBody)) {
      event("game-ended", { body: vipBody.slice(0, 2_000) });
      screen("game-ended-vip-menu");
      return;
    }

    const global = anyFinal ? "final-prompt" : anyVote ? "voting" : anyPrompt ? "prompt" : "interstitial";
    if (global !== lastGlobal) {
      event("phase", { phase: global });
      screen(`phase-${String(captureIndex++).padStart(3, "0")}-${global}`);
      lastGlobal = global;
      lastProgress = Date.now();
    }
    if (Date.now() - lastCapture > 7_500) {
      screen(`periodic-${String(captureIndex++).padStart(3, "0")}-${global}`);
      lastCapture = Date.now();
    }
    if (Date.now() - lastProgress > 120_000) {
      screen(`stuck-${String(captureIndex++).padStart(3, "0")}`);
      for (const player of players) await dump(player, "stuck");
      lastProgress = Date.now();
    }
    await players[0].page.waitForTimeout(300);
  }
  for (const player of players) await dump(player, "game-timeout");
  throw new Error("Game did not reach the VIP menu before the 22-minute deadline");
}

async function chooseNewPlayers(vip: Player): Promise<void> {
  const buttons = await visibleButtons(vip.page);
  const target = buttons.find((button) => /^new players$/i.test(button.text.trim()));
  if (!target) {
    await dump(vip, "missing-new-players");
    throw new Error("VIP menu did not contain New Players");
  }
  event("new-players-click", { player: vip.name, button: target.text });
  await vip.page.locator("button, .button").nth(target.index).click();
}

async function observeAfterNewPlayers(players: Player[]): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    await players[0].page.waitForTimeout(1_500);
    const api = await roomInfo(ROOM);
    const clientStates = await Promise.all(players.map(async (player) => ({
      player: player.name,
      url: player.page.url(),
      body: (await visibleText(player.page)).slice(0, 1_000),
    })));
    event("after-new-players-poll", { attempt: i + 1, api, clients: clientStates });
  }
  screen("after-new-players");
  const old = await roomInfo(ROOM);
  if (old.ok === true && (old.body as Record<string, unknown> | undefined)?.appTag === "quiplash3") {
    event("rejoin-code", { code: ROOM, source: "old room API remains live" });
    return ROOM;
  }

  const handoff = `${OUT}rejoin-code.txt`;
  event("rejoin-code-needed", { screenshot: `${OUT}after-new-players.png`, handoff });
  while (Date.now() < deadlineAt) {
    if (existsSync(handoff)) {
      const code = readFileSync(handoff, "utf8").trim().toUpperCase();
      if (/^[A-Z]{4}$/.test(code)) return code;
    }
    await players[0].page.waitForTimeout(1_000);
  }
  throw new Error(`Could not determine the replacement room code; write it to ${handoff}`);
}

async function proveRejoin(browser: Browser, code: string): Promise<void> {
  const player = await attachPlayer(browser, "REJOIN1", code);
  try {
    await player.page.waitForTimeout(3_000);
    const body = await visibleText(player.page);
    event("rejoin-proved", {
      player: player.name,
      code,
      url: player.page.url(),
      body: body.slice(0, 2_000),
      uuid: await player.page.evaluate(() => localStorage.getItem("tv:uuid")),
    });
    screen("after-rejoin");
  } finally {
    await player.context.close();
    event("rejoin-disconnected", { player: player.name });
  }
}

async function main(): Promise<void> {
  writeFileSync(`${OUT}events.jsonl`, "");
  event("recorder-start", { room: ROOM, players: PLAYERS, wallClock: new Date().toISOString() });
  const initial = await roomInfo(ROOM);
  event("room-confirm", { response: initial });
  if (initial.ok !== true || (initial.body as Record<string, unknown> | undefined)?.appTag !== "quiplash3") {
    throw new Error(`${ROOM} is not a live Quiplash 3 room`);
  }

  const browser = await chromium.launch({ headless: true });
  const players: Player[] = [];
  try {
    for (const name of PLAYERS) {
      players.push(await attachPlayer(browser, name, ROOM));
    }
    screen("lobby-four-players");
    await startGame(players[0]);
    await waitForEnd(players);
    await chooseNewPlayers(players[0]);
    const rejoinCode = await observeAfterNewPlayers(players);

    // Disconnect all original players before proving that a clean client can rejoin.
    for (const player of players) await player.context.close().catch(() => {});
    event("original-players-disconnected");
    await proveRejoin(browser, rejoinCode);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    screen("final-empty-lobby");
    event("complete", { rejoinCode });
  } catch (error) {
    event("fatal", { error: String(error), stack: error instanceof Error ? error.stack : undefined });
    screen("fatal");
    for (const player of players) await dump(player, "fatal").catch(() => {});
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
