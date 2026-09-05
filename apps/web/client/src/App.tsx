import { NavLink, Outlet, Route, Routes } from "react-router";

import { ModelPage } from "./pages/ModelPage.js";
import { GamePage } from "./pages/GamePage.js";
import { GamesPage } from "./pages/GamesPage.js";
import { FrontierPage } from "./pages/FrontierPage.js";
import { LeaderboardPage } from "./pages/LeaderboardPage.js";
import { LivePage } from "./pages/LivePage.js";
import { TvPage } from "./pages/TvPage.js";

function SiteLayout() {
  return (
    <div className="site">
      <header className="site__header">
        <NavLink className="wordmark" to="/" end>quiparena</NavLink>
        <nav className="site__nav" aria-label="Primary">
          <NavLink to="/" end>Live</NavLink>
          <NavLink to="/games">Games</NavLink>
          <NavLink to="/leaderboard">Leaderboard</NavLink>
          <NavLink to="/frontier">Frontier</NavLink>
        </nav>
        <a className="site__tv" href="/tv" target="_blank" rel="noreferrer">tv overlay ↗</a>
      </header>
      <main className="site__main"><Outlet /></main>
      <footer className="site__footer">
        <span className="site__fill" aria-hidden="true" />
        <span>made by <a href="https://teejm.com">teej</a></span>
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
        <Route path="models/:slug" element={<ModelPage />} />
        <Route path="leaderboard" element={<LeaderboardPage />} />
        <Route path="frontier" element={<FrontierPage />} />
      </Route>
    </Routes>
  );
}
