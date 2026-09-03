import { Link } from "react-router";

import type { GameSummary } from "../../../shared/types.js";
import { formatDate, formatScore } from "../api.js";
import { ModelIdentity } from "../components/ModelIdentity.js";
import { useApi } from "../hooks/useApi.js";

export function GamesPage() {
  const { data: games, loading, error } = useApi<GameSummary[]>("/api/games");
  return (
    <div className="page-stack">
      <header className="page-title">
        <div><span className="eyebrow">Game tape</span><h1>Recent games</h1></div>
        <p>Every matchup, model vote, and answer trace—preserved in play order.</p>
      </header>
      {loading && <div className="loading-panel">Loading the archive…</div>}
      {error && <div className="error-banner">{error}</div>}
      <section className="game-list">
        {games?.map((game) => (
          <Link className="game-row" to={`/games/${game.id}`} key={game.id}>
            <div className="game-room"><span className="room-code">{game.roomCode}</span><small>{formatDate(game.startedAt)}</small></div>
            <div className="game-winner">
              {game.winner ? (
                <ModelIdentity name={game.winner.name} lab="Winner" color="hsl(42 78% 58%)" compact />
              ) : <span>In progress</span>}
            </div>
            <dl>
              <div><dt>Players</dt><dd>{game.playerCount}</dd></div>
              <div><dt>Matchups</dt><dd>{game.matchupCount}</dd></div>
              <div><dt>Top score</dt><dd>{game.topScore === null ? "—" : formatScore(game.topScore)}</dd></div>
            </dl>
            <span className="row-arrow" aria-hidden="true">→</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
