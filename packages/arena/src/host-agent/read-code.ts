import { readFile } from "node:fs/promises";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { lookupRoom, type RoomInfo } from "@quiparena/jackbox";
import { generateText } from "ai";

export const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash-lite";
export const ROOM_CODE_PATTERN = /^[A-Z]{4}$/;

export type ScreenState = "lobby" | "in-game" | "menu" | "unknown";

export interface ReadCodeResult {
  code: string | null;
  confirmed: boolean;
  screenState: ScreenState;
}

export interface ParsedVisionOutput {
  code: string | null;
  screenState: ScreenState;
}

type GenerateVisionText = (image: Uint8Array, prompt: string) => Promise<string>;
type Lookup = (code: string) => Promise<RoomInfo>;

export interface ReadCodeOptions {
  apiKey?: string;
  model?: string;
  /** Test seam for deterministic mocked model output. */
  generate?: GenerateVisionText;
  /** Test seam for ecast confirmation. */
  lookup?: Lookup;
}

const VISION_PROMPT = [
  "Inspect this game-host screenshot.",
  "Return exactly two plain-text lines and nothing else.",
  "Line 1: the uppercase four-letter room code shown immediately after or below 'Enter room code'.",
  "If this is not a Jackbox lobby showing that code, line 1 must be NONE.",
  "Line 2: exactly one screen state: lobby, in-game, menu, or unknown.",
].join("\n");

const SCREEN_STATES = new Set<ScreenState>(["lobby", "in-game", "menu", "unknown"]);

export function parseVisionOutput(output: string): ParsedVisionOutput {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const codeLine = lines[0] ?? "";
  const stateLine = lines[1]?.toLowerCase() ?? "unknown";
  const screenState: ScreenState = SCREEN_STATES.has(stateLine as ScreenState)
    ? stateLine as ScreenState
    : "unknown";

  return {
    code: codeLine !== "NONE" && ROOM_CODE_PATTERN.test(codeLine) ? codeLine : null,
    screenState,
  };
}

function defaultGenerator(apiKey: string | undefined, modelSlug: string): GenerateVisionText {
  const provider = createOpenRouter({
    ...(apiKey === undefined ? {} : { apiKey }),
    appName: "QuipArena Host Agent",
    compatibility: "strict",
  });
  const model = provider.chat(modelSlug);

  return async (image, prompt) => {
    const result = await generateText({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "file", data: image, mediaType: "image/png" },
        ],
      }],
      maxOutputTokens: 32,
      temperature: 0,
      maxRetries: 1,
      providerOptions: { openrouter: { reasoning: { effort: "none" } } },
    });
    return result.text;
  };
}

/** Read and ecast-confirm a Quiplash 3 room code from a PNG. */
export async function readRoomCode(imagePath: string, options: ReadCodeOptions = {}): Promise<ReadCodeResult> {
  const image = await readFile(imagePath);
  const modelSlug = options.model ?? process.env["HOST_AGENT_VISION_MODEL"] ?? DEFAULT_VISION_MODEL;
  const generate = options.generate
    ?? defaultGenerator(options.apiKey ?? process.env["OPENROUTER_API_KEY"], modelSlug);
  const parsed = parseVisionOutput(await generate(image, VISION_PROMPT));
  if (!parsed.code) return { ...parsed, confirmed: false };

  try {
    const room = await (options.lookup ?? lookupRoom)(parsed.code);
    return { ...parsed, confirmed: room.appTag === "quiplash3" };
  } catch {
    return { ...parsed, confirmed: false };
  }
}
