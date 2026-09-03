import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { captureScreen, prepareImageForVision } from "./capture.js";
import { readRoomCode, type ReadCodeOptions, type ReadCodeResult, type ScreenState } from "./read-code.js";

export const DEFAULT_HOST_AGENT_INTERVAL_S = 15;

export interface HostAgentStatus {
  code: string | null;
  confirmed: boolean;
  screenState: ScreenState;
  updatedAt: string;
  lastError: string | null;
}

export interface HostAgentIterationResult extends ReadCodeResult {
  updatedAt: string;
  lastError: string | null;
}

export interface HostAgentLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface RunHostAgentOptions extends ReadCodeOptions {
  roomFile: string;
  intervalS?: number;
  once?: boolean;
  image?: string;
  signal?: AbortSignal;
  logger?: HostAgentLogger;
}

const DEFAULT_LOGGER: HostAgentLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error ?? ""),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function statusFilePath(roomFile: string): string {
  return `${roomFile}.status.json`;
}

/** Atomically update the worker room file, avoiding a rewrite when unchanged. */
export async function writeRoomFileIfChanged(roomFile: string, code: string): Promise<boolean> {
  if (!/^[A-Z]{4}$/.test(code)) throw new Error(`Invalid room code: ${code}`);
  let current: string | undefined;
  try {
    current = (await readFile(roomFile, "utf8")).trim().toUpperCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current === code) return false;
  await atomicWrite(roomFile, `${code}\n`);
  return true;
}

export async function writeHostAgentStatus(roomFile: string, status: HostAgentStatus): Promise<void> {
  await atomicWrite(statusFilePath(roomFile), `${JSON.stringify(status, null, 2)}\n`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(cleanup, ms);
    const abort = (): void => cleanup();
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function statusFrom(result: HostAgentIterationResult): HostAgentStatus {
  return {
    code: result.code,
    confirmed: result.confirmed,
    screenState: result.screenState,
    updatedAt: result.updatedAt,
    lastError: result.lastError,
  };
}

/** Poll the host display, publishing only ecast-confirmed Quiplash 3 codes. */
export async function runHostAgent(options: RunHostAgentOptions): Promise<HostAgentIterationResult> {
  const intervalS = options.intervalS ?? DEFAULT_HOST_AGENT_INTERVAL_S;
  if (!Number.isFinite(intervalS) || intervalS <= 0) {
    throw new Error("--interval-s must be a positive number");
  }
  const logger = options.logger ?? DEFAULT_LOGGER;
  const workDirectory = await mkdtemp(join(tmpdir(), "quiparena-host-agent-"));
  const preparedImage = join(workDirectory, "screen.png");
  let lastResult: HostAgentIterationResult = {
    code: null,
    confirmed: false,
    screenState: "unknown",
    updatedAt: new Date().toISOString(),
    lastError: null,
  };

  try {
    while (!options.signal?.aborted) {
      try {
        if (options.image) {
          await prepareImageForVision(options.image, preparedImage);
        } else {
          await captureScreen(preparedImage);
        }
        const result = await readRoomCode(preparedImage, options);
        lastResult = {
          ...result,
          updatedAt: new Date().toISOString(),
          lastError: null,
        };

        if (result.confirmed && result.code) {
          const changed = await writeRoomFileIfChanged(options.roomFile, result.code);
          if (changed) {
            logger.warn(`[quiparena/host-agent] *** ROOM CODE CHANGED TO ${result.code} ***`);
          } else {
            logger.info(`[quiparena/host-agent] confirmed room ${result.code} (${result.screenState})`);
          }
        } else {
          logger.warn(
            `[quiparena/host-agent] no confirmed Quiplash 3 room`
            + `${result.code ? ` (vision read ${result.code})` : ""}; screen=${result.screenState}`,
          );
        }
      } catch (error) {
        lastResult = {
          code: null,
          confirmed: false,
          screenState: "unknown",
          updatedAt: new Date().toISOString(),
          lastError: errorMessage(error),
        };
        logger.error("[quiparena/host-agent] pass failed", error);
      }

      try {
        await writeHostAgentStatus(options.roomFile, statusFrom(lastResult));
      } catch (error) {
        lastResult = { ...lastResult, lastError: `Could not write status: ${errorMessage(error)}` };
        logger.error("[quiparena/host-agent] status write failed", error);
      }

      if (options.once) return lastResult;
      await delay(intervalS * 1_000, options.signal);
    }
    return lastResult;
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}
