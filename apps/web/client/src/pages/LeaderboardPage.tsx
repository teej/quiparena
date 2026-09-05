import { Link, useSearchParams } from "react-router";
import type { LeaderboardResponse } from "../../../shared/types.js";
import { useApi } from "../hooks/useApi.js";
import { POPULATIONS, SHOW_VOTER_CONTROLS, usePopulation } from "../hooks/usePopulation.js";

export function LeaderboardPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? "standard";
  const [population, setPopulation] = usePopulation();
  const { data, loading, error } = useApi<LeaderboardResponse>(`/api/leaderboard?population=${population}&view=${encodeURIComponent(view)}`);
  const entries = [...(data?.entries ?? [])].sort((left, right) =>
    Number(right.matchupsPlayed > 0) - Number(left.matchupsPlayed > 0)
    || (left.matchupsPlayed > 0 ? right.rating - left.rating : left.name.localeCompare(right.name)));

  return (
    <div className="page">
      <header className="page__head">
        <h1>Leaderboard</h1>
        <p>
          Bradley–Terry ratings with 95% confidence intervals.
        </p>
      </header>
      {SHOW_VOTER_CONTROLS && (
      <div className="segmented" role="group" aria-label="Whose votes">
        <span className="segmented__label">voters</span>
        {POPULATIONS.map(([value, label]) => (
          <button type="button" aria-pressed={population === value} onClick={() => setPopulation(value)} key={value}>{label}</button>
        ))}
      </div>
      )}
      <div className="segmented" role="group" aria-label="Rating method">
        {([["standard", "All votes"], ["cross-family", "Cross-family"], ["family-balanced", "Family-balanced"]] as const).map(([value, label]) =>
          <button key={value} title={value === "cross-family" ? "Exclude judges from either contestant’s family" : value === "family-balanced" ? "Give each judge family equal weight per matchup" : "Count every vote at its original weight"} aria-pressed={view === value} onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set("view", value); return next; })}>{label}</button>)}
      </div>
      {loading && <p className="note">loading</p>}
      {error && <p className="note note--error">{error}</p>}
      {data && entries.length === 0 && (
        <p className="note">
          No results.
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
                  data-unrated={entry.matchupsPlayed === 0}
                  title={entry.benched ? entry.benchReason ?? "benched" : undefined}
                >
                  <td className="num dim">{entry.matchupsPlayed > 0 ? index + 1 : "—"}</td>
                  <td><Link to={`/models/${encodeURIComponent(entry.modelId)}`}><strong>{entry.name}</strong></Link><span className="board__id">{entry.modelId}</span></td>
                  <td className="num board__rating" title={entry.matchupsPlayed === 0 ? undefined : `95% bootstrap interval: ${entry.intervalLow}–${entry.intervalHigh}`}>
                    <span className="board__rating-grid">
                      <span className="board__rating-value">{entry.matchupsPlayed === 0 ? "—" : entry.rating}</span>
                      {entry.matchupsPlayed > 0 && <span className="board__plus-minus">±{plusMinus}</span>}
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
