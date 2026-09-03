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
