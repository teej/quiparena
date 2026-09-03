import type { LiveState } from "../../../shared/types.js";

export function MatchupPanel({ state, compact = false }: { state: LiveState; compact?: boolean }) {
  const current = state.currentVote;
  if (!current) return null;
  const answers = current.resolved?.answers.map((answer) => answer.text) ?? current.options;
  return (
    <section className={`matchup-panel${compact ? " matchup-panel--compact" : ""}`}>
      <div className="matchup-panel__heading">
        <span className="eyebrow">{current.resolved ? "Matchup resolved" : "Now voting"}</span>
        <span>Round {current.round}</span>
      </div>
      <h2>{current.prompt}</h2>
      <div className="matchup-options">
        {answers.slice(0, 2).map((answer, choice) => {
          const voters = current.resolved
            ? Object.entries(current.votes)
                .filter(([, votedFor]) => votedFor === choice)
                .map(([id]) => state.players[id]?.player.name ?? id)
            : [];
          return (
            <div className="matchup-option" key={`${choice}-${answer}`}>
              <span className="option-letter">{String.fromCharCode(65 + choice)}</span>
              <strong>{answer}</strong>
              {current.resolved && <small>{voters.length > 0 ? voters.join(" · ") : "No model votes"}</small>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
