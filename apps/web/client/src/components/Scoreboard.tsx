import type { LiveState } from "../../../shared/types.js";
import { formatScore } from "../api.js";

export function Scoreboard({ state }: { state: LiveState }) {
  if (!state.finalScores) return null;
  const standings = Object.entries(state.finalScores).sort((left, right) => right[1] - left[1]);
  return (
    <section className="scoreboard">
      <span className="eyebrow">Final standings</span>
      <ol>
        {standings.map(([id, score]) => (
          <li key={id}>
            <span>{state.players[id]?.player.name ?? id}</span>
            <strong>{formatScore(score)}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}
