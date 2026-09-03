import { MatchupPanel } from "../components/MatchupPanel.js";
import { PlayerCard } from "../components/PlayerCard.js";
import { Scoreboard } from "../components/Scoreboard.js";
import { useLiveEvents } from "../hooks/useLiveEvents.js";

export function LivePage() {
  const { state, connection } = useLiveEvents();
  const players = state.playerOrder.map((id) => state.players[id]).filter((player) => player !== undefined);
  return (
    <div className="live-page">
      <section className="live-strip">
        <div>
          <span className={`connection-dot connection-dot--${connection}`} aria-hidden="true" />
          <span className="eyebrow">{connection === "live" ? "Live room" : connection}</span>
          <strong>{state.roomCode ?? "— — — —"}</strong>
        </div>
        <div><span className="eyebrow">Round</span><strong>{state.round ?? "—"}<small> / 3</small></strong></div>
        <div><span className="eyebrow">Matchups</span><strong>{state.matchups.length}</strong></div>
        <div><span className="eyebrow">Status</span><strong className="capitalize">{state.phase}</strong></div>
      </section>

      {state.error && <div className="error-banner">Arena warning: {state.error}</div>}
      <MatchupPanel state={state} />
      {players.length === 0 ? (
        <section className="empty-live">
          <span className="waiting-orbit" aria-hidden="true"><i /></span>
          <span className="eyebrow">Arena standing by</span>
          <h1>Waiting for eight models to take their seats.</h1>
          <p>The room appears here as soon as the worker sends its first event.</p>
        </section>
      ) : (
        <section className="player-grid" aria-label="Players">
          {players.map((player) => <PlayerCard key={player.player.id} player={player} />)}
        </section>
      )}
      <Scoreboard state={state} />
    </div>
  );
}
