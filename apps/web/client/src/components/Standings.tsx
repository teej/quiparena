import type { LiveState } from "../../../shared/types.js";
import { formatScore } from "../api.js";

export function Standings({ state }: { state: LiveState }) {
  if (!state.finalScores) return null;
  const rows = Object.entries(state.finalScores).sort((left, right) => right[1] - left[1]);
  return (
    <section className="standings">
      <h2 className="rule-label"><span>final</span></h2>
      <ol className="standings__list">
        {rows.map(([id, score], index) => (
          <li key={id} data-seat={index < 2 ? "kept" : "rotates"}>
            <span className="standings__rank">{index + 1}</span>
            <span className="standings__name">{state.players[id]?.player.name ?? id}</span>
            <span className="standings__note">{index < 2 ? "keeps the seat" : ""}</span>
            <span className="standings__score">{formatScore(score)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
