import { useState } from "react";

import type { LeaderboardPopulation, LeaderboardResponse } from "../../../shared/types.js";
import { useApi } from "../hooks/useApi.js";

const POPULATIONS: ReadonlyArray<readonly [LeaderboardPopulation, string]> = [
  ["player", "models"],
  ["audience", "chat"],
  ["blended", "both"],
];

export function LeaderboardPage() {
  const [population, setPopulation] = useState<LeaderboardPopulation>("player");
  const { data, loading, error } = useApi<LeaderboardResponse>(`/api/leaderboard?population=${population}`);
  const entries = data?.entries ?? [];

  return (
    <div className="page">
      <header className="page__head">
        <h1>Leaderboard</h1>
        <p>
          Bradley–Terry rating over every matchup, on the Elo scale. ± is the larger half-width of the 95% bootstrap interval.
        </p>
      </header>
      <div className="segmented" role="group" aria-label="Whose votes">
        <span className="segmented__label">voters</span>
        {POPULATIONS.map(([value, label]) => (
          <button type="button" aria-pressed={population === value} onClick={() => setPopulation(value)} key={value}>{label}</button>
        ))}
      </div>
      {loading && <p className="note">loading</p>}
      {error && <p className="note note--error">{error}</p>}
      {data && entries.length === 0 && (
        <p className="note">
          {population === "player" ? "No rated matchups yet." : "Chat voting is not wired up yet, so there is nothing to rate here."}
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
                <tr key={entry.modelId}>
                  <td className="num dim">{index + 1}</td>
                  <td><strong>{entry.name}</strong><span className="board__id">{entry.modelId}</span></td>
                  <td className="num board__rating" title={`95% bootstrap interval: ${entry.intervalLow}–${entry.intervalHigh}`}>
                    <span className="board__rating-grid">
                      <span className="board__rating-value">{entry.rating}</span>
                      <span className="board__plus-minus">±{plusMinus}</span>
                    </span>
                  </td>
                  <td className="num">{entry.games}</td>
                  <td className="num">{entry.wins}</td>
                  <td className="num" title="wins–losses–ties">
                    {entry.matchupWins}–{entry.matchupLosses}{entry.matchupTies > 0 ? `–${entry.matchupTies}` : ""}
                    <span className="dim"> ({Math.round(entry.matchupWinRate * 100)}%)</span>
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
