import { useState } from "react";

import type { LeaderboardPopulation, LeaderboardResponse } from "../../../shared/types.js";
import { useApi } from "../hooks/useApi.js";

const POPULATIONS: ReadonlyArray<readonly [LeaderboardPopulation, string]> = [
  ["player", "Model votes"],
  ["audience", "Audience"],
  ["blended", "Blended"],
];

export function LeaderboardPage() {
  const [population, setPopulation] = useState<LeaderboardPopulation>("player");
  const { data, loading, error } = useApi<LeaderboardResponse>(`/api/leaderboard?population=${population}`);
  return (
    <div className="page-stack">
      <header className="page-title leaderboard-title">
        <div><span className="eyebrow">Arena ratings</span><h1>Leaderboard</h1></div>
        <div className="population-toggle" role="group" aria-label="Vote population">
          {POPULATIONS.map(([value, label]) => (
            <button type="button" className={population === value ? "active" : ""} onClick={() => setPopulation(value)} key={value}>{label}</button>
          ))}
        </div>
      </header>
      <p className="ratings-note">Ratings are Elo-scaled from head-to-head matchups. Intervals show 95% uncertainty. Audience voting is not wired yet, so audience-only results remain empty and blended currently follows model votes.</p>
      {loading && <div className="loading-panel">Calculating ratings…</div>}
      {error && <div className="error-banner">{error}</div>}
      {data && (
        <div className="table-wrap">
          <table className="leaderboard-table">
            <thead><tr><th>Rank</th><th>Model</th><th>Rating</th><th>95% interval</th><th>Games</th><th>Wins</th><th>Matchup win rate</th></tr></thead>
            <tbody>
              {data.entries.map((entry, index) => (
                <tr key={entry.modelId}>
                  <td><span className="rank">{index + 1}</span></td>
                  <td><strong>{entry.name}</strong><small>{entry.lab}<br />{entry.modelId}</small></td>
                  <td className="rating-cell">{entry.rating}</td>
                  <td>{entry.intervalLow}–{entry.intervalHigh}</td>
                  <td>{entry.games}</td>
                  <td>{entry.wins}</td>
                  <td><strong>{Math.round(entry.matchupWinRate * 100)}%</strong><small>{entry.matchupWins}–{entry.matchups - entry.matchupWins}</small></td>
                </tr>
              ))}
              {data.entries.length === 0 && <tr><td colSpan={7} className="empty-table">Audience results will appear here after voting is connected.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
