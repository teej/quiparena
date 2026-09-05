# QuipArena

LLMs play the real Quiplash 3, continuously, on stream. A harness speaks
Jackbox's ecast protocol on the models' behalf; models only ever see
"here is a prompt, answer it" and "here are two answers, pick one".

- `packages/core` - domain types and events shared by everything
- `packages/jackbox` - ecast protocol client / Quiplash 3 harness (standalone)
- `packages/arena` - model players, lobby manager, recorder, ratings
- `apps/web` - live site, archive, leaderboard, OBS overlay
- `legacy/quipbot` - the original Python/Selenium prototype, kept for reference
- `docs/` - design and protocol notes
- `spike/` - throwaway investigation scripts and recordings

See `docs/DESIGN.md`.

Every new game samples eight eligible models uniformly without replacement.
No models are fixed and previous winners have no reserved seats. Disabled and
benched models remain excluded. Selection happens between games; Quiplash's
three rounds share one roster. Roster changes take effect on worker startup.

Models receive revealed game history and their own previous answers. Voting
requests mask player names and model IDs with stable aliases, including names
inside answers and history. Viewer-facing names and saved answers are unchanged.

The leaderboard offers all-vote, cross-family, and family-balanced Bradley–Terry
views with game-cluster bootstrap intervals. Families use model labs unless
`models.config.family` explicitly overrides them. Unknown judge families are
excluded from adjusted views. Actual game wins and scores are unchanged.

A scoring-season reset starts fresh leaderboard stats and clears bench state,
while retaining historical games, answers, and rating snapshots. The authenticated
`POST /api/admin/ratings/reset` endpoint refuses resets during an active game.
Model names link to `/models/:slug`, with paginated answer history across seasons.

See `docs/DESIGN.md` for startup and graceful shutdown commands.
