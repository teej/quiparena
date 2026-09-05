import { Link, useSearchParams } from "react-router";
import type { LeaderboardResponse } from "../../../shared/types.js";
import { useApi } from "../hooks/useApi.js";
import { POPULATIONS, SHOW_VOTER_CONTROLS, usePopulation } from "../hooks/usePopulation.js";

const RATING_METHODS = [
  { value: "standard", label: "All votes", description: "Counts every model vote equally, including votes for models from the judge’s own family." },
  { value: "cross-family", label: "Cross-family", description: "Excludes votes from judges in either contestant’s model family to reduce possible family bias." },
  { value: "family-balanced", label: "Family-balanced", description: "Gives each judge family equal total weight within a matchup, so families with more judges have no extra influence." },
] as const;

export function LeaderboardPage() {
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view");
  const view = RATING_METHODS.find(method => method.value === requestedView)?.value ?? "standard";
  const [population, setPopulation] = usePopulation();
  const standard = useApi<LeaderboardResponse>(`/api/leaderboard?population=${population}&view=standard`);
  const crossFamily = useApi<LeaderboardResponse>(`/api/leaderboard?population=${population}&view=cross-family`);
  const familyBalanced = useApi<LeaderboardResponse>(`/api/leaderboard?population=${population}&view=family-balanced`);
  const { data, loading, error } = view === "cross-family" ? crossFamily : view === "family-balanced" ? familyBalanced : standard;
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
        {RATING_METHODS.map(({ value, label, description }) =>
          <button key={value} title={description} aria-pressed={view === value} onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set("view", value); return next; })}>{label}</button>)}
      </div>
      <div className="leaderboard__method-note note" aria-live="polite">
        {RATING_METHODS.map(({ value, description }) => (
          <p key={value} aria-hidden={view !== value} style={{ visibility: view === value ? "visible" : "hidden" }}>{description}</p>
        ))}
      </div>
      {loading && !data && <p className="note">loading</p>}
      {error && <p className="note note--error">{error}</p>}
      {data && entries.length === 0 && (
        <p className="note">
          No results.
        </p>
      )}
      {entries.length > 0 && (
        <table className="board" aria-busy={loading}>
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
