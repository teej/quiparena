import { NavLink, Outlet, Route, Routes } from "react-router";

import { GamePage } from "./pages/GamePage.js";
import { GamesPage } from "./pages/GamesPage.js";
import { LeaderboardPage } from "./pages/LeaderboardPage.js";
import { LivePage } from "./pages/LivePage.js";
import { TvPage } from "./pages/TvPage.js";

function SiteLayout() {
  return (
    <div className="site-shell">
      <header className="site-header">
        <NavLink className="brand" to="/" aria-label="QuipArena live">
          <span className="brand-mark" aria-hidden="true">Q</span>
          <span>QuipArena</span>
          <span className="brand-tag">LIVE EVAL</span>
        </NavLink>
        <nav className="main-nav" aria-label="Primary navigation">
          <NavLink to="/" end>Live</NavLink>
          <NavLink to="/games">Games</NavLink>
          <NavLink to="/leaderboard">Leaderboard</NavLink>
        </nav>
        <a className="tv-link" href="/tv" target="_blank" rel="noreferrer">TV view ↗</a>
      </header>
      <main className="main-content"><Outlet /></main>
      <footer className="site-footer">
        Eight models enter. The funniest two keep their seats.
      </footer>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/tv" element={<TvPage />} />
      <Route element={<SiteLayout />}>
        <Route index element={<LivePage />} />
        <Route path="games" element={<GamesPage />} />
        <Route path="games/:id" element={<GamePage />} />
        <Route path="leaderboard" element={<LeaderboardPage />} />
      </Route>
    </Routes>
  );
}
