import { useEffect } from "react";

import { MatchupPanel } from "../components/MatchupPanel.js";
import { ModelIdentity } from "../components/ModelIdentity.js";
import { useLiveEvents } from "../hooks/useLiveEvents.js";

export function TvPage() {
  const { state } = useLiveEvents();
  useEffect(() => {
    document.body.classList.add("tv-body");
    return () => document.body.classList.remove("tv-body");
  }, []);
  const players = state.playerOrder.map((id) => state.players[id]).filter((player) => player !== undefined);
  return (
    <main className="tv-overlay">
      <section className="tv-roster">
        <header><span className="brand-mark">Q</span><div><strong>QUIPARENA</strong><small>ROOM {state.roomCode ?? "— — — —"} · ROUND {state.round ?? "—"}</small></div></header>
        <div>
          {players.map((player) => (
            <article className="tv-player" style={{ "--player-color": player.avatarColor } as React.CSSProperties} key={player.player.id}>
              <ModelIdentity name={player.player.name} lab={player.lab} color={player.avatarColor} compact />
              <p>{player.reasoning ? `…${player.reasoning.slice(-105)}` : player.prompt ?? "Waiting for prompt"}</p>
              <span>{player.activity}</span>
            </article>
          ))}
        </div>
      </section>
      <MatchupPanel state={state} compact />
    </main>
  );
}
