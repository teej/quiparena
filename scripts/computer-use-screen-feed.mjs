// Run from the Computer Use Node session, passing its documented `sky` API.
// This supplies --image to the existing host agent without shell screen capture.
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export async function feedJackboxScreen({ sky, dataDir, durationMs, intervalMs = 15_000 }) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("A positive durationMs is required");
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error("intervalMs must be at least 1000");
  await mkdir(join(dataDir, "run"), { recursive: true });
  const statusPath = join(dataDir, "screen-feed.status.json");
  const stopPath = join(dataDir, "run", "screen-feed.stop");
  const deadline = Date.now() + durationMs;
  let reason = "duration";
  let captures = 0;
  while (Date.now() < deadline) {
    try {
      await readFile(stopPath);
      reason = "stop-file";
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      const state = await sky.get_app_state({ app: "com.jackboxgames.tjpp7" });
      if (!state.screenshot) throw new Error("No Jackbox screenshot returned");
      const temporary = join(dataDir, "host-screen.next.png");
      await copyFile(fileURLToPath(state.screenshot.url), temporary);
      await rename(temporary, join(dataDir, "host-screen.png"));
      captures++;
      await writeFile(statusPath, JSON.stringify({ updatedAt: new Date().toISOString(), ok: true, captures }));
    } catch (error) {
      await writeFile(statusPath, JSON.stringify({ updatedAt: new Date().toISOString(), ok: false, error: String(error), captures }));
      // A stale image must not be treated as a live screen indefinitely.
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  await writeFile(statusPath, JSON.stringify({ updatedAt: new Date().toISOString(), ok: false, stopped: reason, captures }));
  return { reason, captures };
}
