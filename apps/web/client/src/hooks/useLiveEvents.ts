import type { AnyEvent } from "@quiparena/core";
import { useEffect, useState } from "react";

import { createEmptyLiveState, reduceLiveState } from "../../../shared/reducer.js";
import type { LiveState } from "../../../shared/types.js";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export function useLiveEvents(): { state: LiveState; connection: ConnectionStatus } {
  const [state, setState] = useState<LiveState>(createEmptyLiveState);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 750;
    let stopped = false;

    const connect = (): void => {
      if (stopped) return;
      source = new EventSource("/api/live");
      source.addEventListener("open", () => {
        retryMs = 750;
        setConnection("live");
      });
      source.addEventListener("snapshot", (message) => {
        try {
          setState(JSON.parse((message as MessageEvent<string>).data) as LiveState);
        } catch {
          setConnection("reconnecting");
        }
      });
      source.addEventListener("event", (message) => {
        try {
          const event = JSON.parse((message as MessageEvent<string>).data) as AnyEvent;
          setState((current) => reduceLiveState(current, event));
        } catch {
          setConnection("reconnecting");
        }
      });
      source.addEventListener("error", () => {
        source?.close();
        source = null;
        if (stopped || retryTimer) return;
        setConnection("reconnecting");
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, retryMs);
        retryMs = Math.min(retryMs * 1.8, 10_000);
      });
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  return { state, connection };
}
