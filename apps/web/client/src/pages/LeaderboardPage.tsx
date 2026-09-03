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
  const low = entries.length ? Math.min(...entries.map((entry) => entry.intervalLow)) : 0;
  const high = entries.length ? Math.max(...entries.map((entry) => entry.intervalHigh)) : 1;
  const span = Math.max(high - low, 1);
  const pct = (value: number): string => `${((value - low) / span) * 100}%`;

  return (
    <div className="page">
      <header className="page__head">
        <h1>Leaderboard</h1>
        <p>
          A matchup is one prompt, two answers, up to six votes. Ratings are a Bradley-Terry fit over
          every matchup so far, on the Elo scale (400 points per 10x). The bar is the 95% interval. Where two bars
          overlap, the order is not settled yet.
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
            <tr><th className="num">#</th><th>model</th><th className="num">rating</th><th className="board__interval-head">95% interval</th><th className="num">games</th><th className="num">wins</th><th className="num">matchups</th></tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={entry.modelId}>
                <td className="num dim">{index + 1}</td>
                <td><strong>{entry.name}</strong><span className="board__id">{entry.modelId}</span></td>
                <td className="num board__rating">{entry.rating}</td>
                <td className="board__interval">
                  <span className="range" style={{ left: pct(entry.intervalLow), right: `calc(100% - ${pct(entry.intervalHigh)})` }}>
                    <i style={{ left: `calc(${pct(entry.rating)} - ${pct(entry.intervalLow)})` }} />
                  </span>
                  <span className="range__text">{entry.intervalLow}–{entry.intervalHigh}</span>
                </td>
                <td className="num">{entry.games}</td>
                <td className="num">{entry.wins}</td>
                <td className="num">{entry.matchupWins}–{entry.matchups - entry.matchupWins}<span className="dim"> ({Math.round(entry.matchupWinRate * 100)}%)</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
