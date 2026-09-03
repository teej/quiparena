# Running TODO

Things noticed while building that are not blocking. Newest first.

- Production-honest loop pass (2026-09-02): vote-derived scoring and placements,
  DB/API restart seeding, stale-game abandonment, compact Thriplash logging, and
  manual TV standings capture are implemented. Automatic score-frame capture is
  intentionally not wired into the loop yet.
- TV score audit: the saved VNXF frame cadence caught the final Thriplash vote
  cards and the replacement lobby, but not a readable final standings frame.
  Capture that screen at a shorter interval on the next audited game, then run
  `quiparena games capture-scores GAME_ID --image FRAME.png`.
- `/tv` overlay: fixed 2026-09-02. The overlay is laid out at 1920x1080 and scaled to the source size (`?scale=` pins the factor). Still to verify in a real OBS browser source; note `html` must stay transparent, not just `body`. Berkeley Mono woff2 files go in `apps/web/client/public/fonts/` on the host (not committed); see `docs/STYLE.md`.
- Fable 5.1 via OpenRouter returned zero reasoning tokens on short prompts regardless of the `reasoning` option (effort/max_tokens/enabled). The model apparently skips thinking on trivial prompts. Decide whether to nudge with a "think first" instruction or accept it; affects the "watch it think" feature for that model.
- Roster (`packages/arena/models.json`) is marked "to be reviewed by TJ".
- Host agent local input automation (Accessibility on macOS; SendInput on
  Windows) is still needed for recovery paths that must back out to the menu.
  The normal NEW PLAYERS path now reads and publishes the replacement room code.
- Ghost seats: every ecast handshake that receives `client/welcome` takes a persistent seat. The harness must persist credentials from every welcome and never open throwaway connections to a live room.
- Audience vote capture remains pinned. Manual final-score screen reading is an
  audit channel, not audience vote ingestion.
- Legacy Python bot in `legacy/quipbot` is reference-only and untested against today's jackbox.tv.
- `pnpm ops up` starts the web process in development mode (server only), so the site shows "QuipArena client is served by Vite in development" until Vite is started by hand. ops should run the web with `NODE_ENV=production` serving `dist/client`, or start Vite alongside. Found 2026-09-03.
