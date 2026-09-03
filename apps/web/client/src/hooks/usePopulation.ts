import { useState } from "react";

import type { LeaderboardPopulation } from "../../../shared/types.js";

/** The voter toggle shared by the leaderboard and the frontier: models / chat / both. */
export const POPULATIONS: ReadonlyArray<readonly [LeaderboardPopulation, string]> = [
  ["player", "models"],
  ["audience", "chat"],
  ["blended", "both"],
];

const KEY = "quiparena.population";

function read(): LeaderboardPopulation {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored === "audience" || stored === "blended" || stored === "player") return stored;
  } catch {
    // storage is unavailable in some embeds; the default is fine
  }
  return "player";
}

export function usePopulation(): [LeaderboardPopulation, (next: LeaderboardPopulation) => void] {
  const [population, setPopulation] = useState<LeaderboardPopulation>(read);
  const update = (next: LeaderboardPopulation): void => {
    setPopulation(next);
    try {
      sessionStorage.setItem(KEY, next);
    } catch {
      // ignore
    }
  };
  return [population, update];
}
