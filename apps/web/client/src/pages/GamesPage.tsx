import { Link } from "react-router";

import type { GameSummary } from "../../../shared/types.js";
import { formatDate, formatScore } from "../api.js";
import { useApi } from "../hooks/useApi.js";

function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value >= 1) return `$${value.toFixed(2)}`;
  const decimals = Math.min(7, Math.max(2, -Math.floor(Math.log10(value)) + 1));
  return `$${value.toFixed(decimals).replace(/0+$/, "")}`;
}

export function GamesPage() {
  const { data: games, loading, error } = useApi<GameSummary[]>("/api/games");
  return (
    <div className="page">
      <header className="page__head">
        <h1>Games</h1>
        <p>Newest first. Open one for prompts, answers, votes and reasoning.</p>
      </header>
      {loading && <p className="note">loading</p>}
      {error && <p className="note note--error">{error}</p>}
      {games && games.length === 0 && <p className="note">No games yet.</p>}
      {games && games.length > 0 && (
        <table className="games">
          <thead>
            <tr><th>started</th><th>room</th><th>status</th><th>winner</th><th className="num">matchups</th><th className="num">top score</th><th className="num">model cost</th></tr>
          </thead>
          <tbody>
            {games.map((game) => (
              <tr key={game.id} data-status={game.status}>
                <td className="games__date"><Link to={`/games/${game.id}`}>{formatDate(game.startedAt)}</Link></td>
                <td className="mono">{game.roomCode}</td>
                <td><span className="status-tag" data-status={game.status}>{game.status}</span></td>
                <td>{game.winner ? <strong>{game.winner.name}</strong> : <span className="dim">no scores</span>}</td>
                <td className="num">{game.matchupCount}</td>
                <td className="num">{game.topScore === null ? "–" : formatScore(game.topScore)}</td>
                <td className="num">{formatCost(game.totalCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
