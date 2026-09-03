import type { LiveState } from "../../../shared/types.js";
import { formatScore } from "../api.js";

export function Standings({ state }: { state: LiveState }) {
  const observed = state.observedScores !== null;
  const scores = state.observedScores ?? state.finalScores;
  if (!scores) return null;
  const rows = Object.entries(scores).sort((left, right) => {
    const leftPlacement = state.observedPlacements?.[left[0]];
    const rightPlacement = state.observedPlacements?.[right[0]];
    if (leftPlacement !== undefined && rightPlacement !== undefined) return leftPlacement - rightPlacement;
    return right[1] - left[1];
  });
  return (
    <section className="standings">
      <h2 className="rule-label"><span>{observed ? "observed final" : "final"}</span></h2>
      <ol className="standings__list">
        {rows.map(([id, score], index) => (
          <li key={id} data-seat={index < 2 ? "kept" : "rotates"}>
            <span className="standings__rank">{state.observedPlacements?.[id] ?? index + 1}</span>
            <span className="standings__name">{state.players[id]?.player.name ?? id}</span>
            <span className="standings__note">{index < 2 ? "keeps the seat" : ""}</span>
            <span className="standings__score">{formatScore(score)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
