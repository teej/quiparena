import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { LeaderboardPopulation } from "../shared/types.js";
import type { LiveCoordinator } from "./live.js";
import type { Store } from "./store.js";
import { bearerToken, equalTokens } from "./auth.js";

export interface AppOptions {
  store: Store;
  live: LiveCoordinator;
  ingestToken: string;
  recomputeRatings?: () => Promise<unknown>;
  production?: boolean;
  clientRoot?: string;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.get("/api/health", (context) => context.json({
    ok: true,
    currentGameId: options.live.state.gameId,
    subscribers: options.live.subscriberCount,
    now: new Date().toISOString(),
  }));

  app.get("/api/live", (context) => {
    context.header("Cache-Control", "no-cache, no-transform");
    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      let writes = stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(options.live.state),
      });
      const unsubscribe = options.live.subscribe((event) => {
        writes = writes
          .then(() => stream.writeSSE({ event: "event", data: JSON.stringify(event) }))
          .catch(() => undefined);
      });
      const keepAlive = setInterval(() => {
        writes = writes
          .then(() => stream.writeSSE({ event: "ping", data: Date.now().toString() }))
          .catch(() => undefined);
      }, 15_000);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(keepAlive);
          unsubscribe();
          resolve();
        });
      });
    });
  });

  app.get("/api/games", async (context) => {
    const games = await options.store.listGames();
    const start = context.req.query("season") === "current" ? await options.store.scoringSeason?.() : null;
    return context.json(start ? games.filter(game => game.startedAt >= start) : games);
  });

  app.get("/api/models/:slug", async context => {
    if (!options.store.modelHistory) return context.json({ error: "Model history requires the database store" }, 503);
    const raw = Number(context.req.query("offset") ?? 0);
    const offset = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
    const history = await options.store.modelHistory(context.req.param("slug"), offset);
    return history ? context.json(history) : context.json({ error: "Model not found" }, 404);
  });

  app.get("/api/games/:id", async (context) => {
    const game = await options.store.getGame(context.req.param("id"));
    if (!game) return context.json({ error: "Game not found" }, 404);
    if (game.game.id === options.live.state.gameId) {
      game.traces = structuredClone(options.live.state.traces);
    }
    return context.json(game);
  });

  app.get("/api/leaderboard", async (context) => {
    const requested = context.req.query("population") ?? "player";
    const population: LeaderboardPopulation = requested === "audience" || requested === "blended"
      ? requested
      : "player";
    const requestedView = context.req.query("view");
    const view = requestedView === "cross-family" || requestedView === "family-balanced" ? requestedView : "standard";
    return context.json(await options.store.leaderboard(population, view));
  });

  app.get("/api/frontier", async (context) => {
    const requested = context.req.query("population") ?? "player";
    const population: LeaderboardPopulation = requested === "audience" || requested === "blended"
      ? requested
      : "player";
    return context.json(await options.store.frontier(population));
  });

  app.post("/api/admin/ratings/reset", async context => {
    if (!equalTokens(bearerToken(context.req.header("Authorization")), options.ingestToken)) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    if (!options.store.resetScoringSeason) return context.json({ error: "Reset requires the database store" }, 503);
    const active = (await options.store.listGames()).some(game => game.status === "running");
    if (active) return context.json({ error: "Finish the active game before resetting ratings" }, 409);
    return context.json({ startedAt: await options.store.resetScoringSeason() });
  });

  app.post("/api/admin/ratings/recompute", async (context) => {
    const token = bearerToken(context.req.header("Authorization")) ?? context.req.query("token") ?? null;
    if (!equalTokens(token, options.ingestToken)) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    if (!options.recomputeRatings) {
      return context.json({ error: "Ratings recompute is unavailable for the active store" }, 503);
    }
    await options.recomputeRatings();
    return context.json({ ok: true });
  });

  const production = options.production ?? process.env["NODE_ENV"] === "production";
  if (production) {
    const clientRoot = options.clientRoot ?? fileURLToPath(new URL("../client", import.meta.url));
    if (!existsSync(join(clientRoot, "index.html"))) {
      throw new Error(
        `QuipArena client build is missing from ${clientRoot}. Run: pnpm --filter @quiparena/web build`,
      );
    }
    app.use("*", serveStatic({ root: clientRoot }));
    app.get("*", serveStatic({ root: clientRoot, path: "index.html" }));
  }

  app.notFound((context) => context.req.path.startsWith("/api/")
    ? context.json({ error: "Not found" }, 404)
    : context.text("QuipArena client is served by Vite in development.", 404));

  return app;
}
