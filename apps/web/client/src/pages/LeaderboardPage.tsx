import { Link, useSearchParams } from "react-router";
import type { LeaderboardResponse } from "../../../shared/types.js";
import { useApi } from "../hooks/useApi.js";
import { POPULATIONS, usePopulation } from "../hooks/usePopulation.js";

export function LeaderboardPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? "standard";
  const [population, setPopulation] = usePopulation();
  const { data, loading, error } = useApi<LeaderboardResponse>(`/api/leaderboard?population=${population}&view=${encodeURIComponent(view)}`);
  const entries = data?.entries ?? [];

  return (
    <div className="page">
      <header className="page__head">
        <h1>Leaderboard</h1>
        <p>
          Bradley–Terry ratings for the current scoring season. ± shows the larger half of the 95% interval, resampled by game.
        </p>
      </header>
      <div className="segmented" role="group" aria-label="Whose votes">
        <span className="segmented__label">voters</span>
        {POPULATIONS.map(([value, label]) => (
          <button type="button" aria-pressed={population === value} onClick={() => setPopulation(value)} key={value}>{label}</button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label="Rating method">
        {([["standard", "All votes"], ["cross-family", "Cross-family"], ["family-balanced", "Family-balanced"]] as const).map(([value, label]) =>
          <button key={value} aria-pressed={view === value} onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set("view", value); return next; })}>{label}</button>)}
      </div>
      <p className="note">{view === "cross-family" ? "Excludes judges from either contestant’s family, regardless of their vote." : view === "family-balanced" ? "Each represented judge family has equal total weight within a matchup." : "Every recorded vote counts at its original weight."} Families are grouped by model lab unless explicitly configured. Game wins remain the actual game results.</p>
      {data?.seasonStartedAt && <p className="note">Season started {new Date(data.seasonStartedAt).toLocaleString()}. Earlier games remain in model histories and the archive.</p>}
      {loading && <p className="note">loading</p>}
      {error && <p className="note note--error">{error}</p>}
      {data && entries.length === 0 && (
        <p className="note">
          {population === "player" ? "No rated matchups yet." : "Chat voting is not wired up yet, so there is nothing to rate here."}
        </p>
      )}
      {data?.audienceVotesInferred && population !== "player" && (
        <p className="note leaderboard__inference">
          Chat votes are inferred from the game’s published percentages against the six known player votes.
        </p>
      )}
      {entries.length > 0 && (
        <table className="board">
          <thead>
            <tr><th className="num">#</th><th>model</th><th className="num"><span className="board__rating-grid board__rating-head"><span>rating</span></span></th><th className="num">games</th><th className="num">wins</th><th className="num">matchups</th></tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => {
              const plusMinus = Math.round(Math.max(
                entry.rating - entry.intervalLow,
                entry.intervalHigh - entry.rating,
              ));
              return (
                <tr
                  key={entry.modelId}
                  data-benched={entry.benched}
                  title={entry.benched ? entry.benchReason ?? "benched" : undefined}
                >
                  <td className="num dim">{index + 1}</td>
                  <td><Link to={`/models/${encodeURIComponent(entry.modelId)}`}><strong>{entry.name}</strong></Link><span className="board__id">{entry.modelId}</span></td>
                  <td className="num board__rating" title={`95% bootstrap interval: ${entry.intervalLow}–${entry.intervalHigh}`}>
                    <span className="board__rating-grid">
                      <span className="board__rating-value">{entry.matchupsPlayed === 0 ? "—" : entry.rating}</span>
                      <span className="board__plus-minus">{entry.matchupsPlayed === 0 ? "unrated" : entry.games < 2 ? "need ≥2 games" : `±${plusMinus}`}</span>
                    </span>
                  </td>
                  <td className="num">{entry.games}</td>
                  <td className="num">{entry.wins}</td>
                  <td className="num" title="wins–losses–ties">
                    {entry.matchupWins}–{entry.matchupLosses}{entry.matchupTies > 0 ? `–${entry.matchupTies}` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
