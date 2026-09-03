import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAdaptorServer } from "@hono/node-server";
import type { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";

import { createApp } from "./app.js";
import { bearerToken, equalTokens } from "./auth.js";
import { LiveCoordinator, parseIngestEvent } from "./live.js";
import { InMemoryStore, type Store } from "./store.js";

export interface ServerOptions {
  ingestToken: string;
  store?: Store;
  coalesceMs?: number;
  production?: boolean;
  clientRoot?: string;
  recomputeRatings?: () => Promise<unknown>;
}

export interface QuipArenaServer {
  app: Hono;
  httpServer: Server;
  store: Store;
  live: LiveCoordinator;
  start(port?: number, hostname?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

function requestToken(request: import("node:http").IncomingMessage): string | null {
  const authorization = bearerToken(request.headers.authorization);
  if (authorization) return authorization;
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

function storeRatingsRecomputer(store: Store): (() => Promise<unknown>) | undefined {
  const candidate = store as Store & { recomputeRatings?: () => Promise<unknown> };
  return typeof candidate.recomputeRatings === "function"
    ? () => candidate.recomputeRatings!()
    : undefined;
}

export function createQuipArenaServer(options: ServerOptions): QuipArenaServer {
  if (!options.ingestToken) throw new Error("INGEST_TOKEN must not be empty");
  const store = options.store ?? new InMemoryStore();
  const live = new LiveCoordinator(store, options.coalesceMs);
  const recomputeRatings = options.recomputeRatings ?? storeRatingsRecomputer(store);
  const appOptions = {
    store,
    live,
    ingestToken: options.ingestToken,
    ...(recomputeRatings === undefined ? {} : { recomputeRatings }),
    ...(options.production === undefined ? {} : { production: options.production }),
    ...(options.clientRoot === undefined ? {} : { clientRoot: options.clientRoot }),
  };
  const app = createApp(appOptions);
  const httpServer = createAdaptorServer({ fetch: app.fetch }) as Server;
  const sockets = new WebSocketServer({ noServer: true });
  let hydration: Promise<void> | undefined;

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ingest") {
      socket.destroy();
      return;
    }
    if (!equalTokens(requestToken(request), options.ingestToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit("connection", webSocket, request);
    });
  });

  sockets.on("connection", (socket) => {
    let processing = Promise.resolve();
    socket.on("message", (data, isBinary) => {
      processing = processing.then(async () => {
        if (isBinary) {
          sendIngestError(socket, "Binary frames are not supported");
          return;
        }
        const lines = data.toString().split(/\r?\n/).filter((line) => line.trim().length > 0);
        for (const line of lines) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(line);
          } catch {
            sendIngestError(socket, "Invalid JSON line");
            continue;
          }
          const event = parseIngestEvent(decoded);
          if (!event) {
            sendIngestError(socket, "Event must have a known type and non-empty gameId");
            continue;
          }
          await live.accept(event);
        }
      }).catch((error: unknown) => {
        sendIngestError(socket, error instanceof Error ? error.message : "Could not process event");
      });
    });
  });

  return {
    app,
    httpServer,
    store,
    live,
    start: async (port = 8787, hostname = "127.0.0.1") => {
      hydration ??= live.hydrate();
      await hydration;
      return new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(port, hostname, () => {
          httpServer.off("error", onError);
          const address = httpServer.address();
          if (!address || typeof address === "string") {
            reject(new Error("Server did not bind to a TCP address"));
            return;
          }
          resolve(address);
        });
      });
    },
    close: async () => {
      live.close();
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      if (!httpServer.listening) return;
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function sendIngestError(socket: WebSocket, message: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "ingest.error", message }));
  }
}
