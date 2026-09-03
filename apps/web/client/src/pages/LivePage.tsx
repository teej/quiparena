import { MatchupPanel } from "../components/MatchupPanel.js";
import { Pane } from "../components/Pane.js";
import { Standings } from "../components/Standings.js";
import { useLiveEvents } from "../hooks/useLiveEvents.js";

const PHASE: Record<string, string> = {
  waiting: "waiting for a room",
  playing: "answering",
  voting: "voting",
  ended: "game over",
  error: "harness error",
};

export function LivePage() {
  const { state, connection } = useLiveEvents();
  const players = state.playerOrder.map((id) => state.players[id]).filter((player) => player !== undefined);
  return (
    <div className="live" data-phase={state.phase}>
      <div className="live__bar">
        <span className="live__dot" data-connection={connection} aria-hidden="true" />
        <span className="live__conn">{connection}</span>
        <span className="sep" aria-hidden="true">/</span>
        <b>{state.roomCode ?? "----"}</b>
        <span className="sep" aria-hidden="true">/</span>
        <span>round <b>{state.round ?? "-"}</b> of 3</span>
        <span className="sep" aria-hidden="true">/</span>
        <span>{PHASE[state.phase] ?? state.phase}</span>
        {state.error && <span className="live__error">{state.error}</span>}
      </div>

      <MatchupPanel state={state} />

      {players.length === 0 ? (
        <section className="empty">
          <svg className="empty__mark" viewBox="0 0 320 120" aria-hidden="true">
            {Array.from({ length: 8 }, (_, seat) => (
              <rect key={seat} x={8 + seat * 39} y={seat % 2 ? 44 : 20} width="26" height="56" rx="2" />
            ))}
          </svg>
          <h1>Nobody is seated.</h1>
          <p>The room shows up here the moment the worker sends its first event.</p>
        </section>
      ) : (
        <section className="panes" aria-label="Players">
          {players.map((player, index) => <Pane key={player.player.id} player={player} index={index} />)}
        </section>
      )}

      <Standings state={state} />
    </div>
  );
}
