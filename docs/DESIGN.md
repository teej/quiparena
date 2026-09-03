# QuipArena design

Decided 2026-09-02. Short by intent; the code is the spec once it exists.

## What it is

LLMs play the real Quiplash 3 (Jackbox Party Pack 7) against each other,
continuously, streamed on Twitch. Three products fall out of it:

1. An autonomous lobby: eight models per game, top two keep their seats, six rotate in.
2. A live website showing each model's reasoning as it plays.
3. A live eval: an arena-style leaderboard rated from head-to-head matchups.

Models never operate a browser. A **harness** speaks Jackbox's ecast websocket
protocol and exposes a `Player` interface (see `packages/jackbox/src/player.ts`):
answer a prompt, give three final answers, vote between options.

## Parts

- **Game host.** Steam + Quiplash 3 + OBS. Dev: TJ's Mac. Prod: cloud Windows VM.
  No headless Jackbox exists; the game process is the host.
- **Harness** (`packages/jackbox`). ecast protocol client for Quiplash 3, standalone
  and open-sourceable. Playwright is the fallback if the protocol turns out hostile.
- **Arena worker** (`packages/arena`). OpenRouter players (AI SDK, streamed
  reasoning, deadline-aware), VIP-driven lobby manager, recorder, Bradley-Terry ratings.
- **Web** (`apps/web`). Hono + Postgres + React SPA + SSE. Live view, archive,
  leaderboard, OBS browser-source overlay.

Worker runs on the game host. Web + Postgres run on Fly/Railway. Worker pushes
events to web over one authenticated websocket; web is the single DB writer.

## Decisions

- Rating unit is the matchup (prompt, two answers, votes) — Bradley-Terry, like LMArena.
- Model votes and audience votes are separate populations; blend later.
- Human vote *ingestion* is pinned. Schema and API carry populations from day one.
- One fixed system prompt for every model in the first pass. Personas are a later experiment.
- No content restrictions. We want to see exactly what the models say.
- Quiplash's own prompts are fine. Custom prompt packs later.
- The game's timer is the reasoning budget. Players cap reasoning effort and answer by deadline.
- Commit messages are literally `quiparena`.

## Build order

0. Spike: record ecast traffic across a full game + "New players" cycle. Pick transport.
1. Scaffold + harness with scripted players, tested against a real room.
2. Model players + CLI that streams eight models' thinking to the terminal.
3. Recorder, DB schema, lobby manager, ratings.
4. Web service + SPA + OBS overlay.
5. Cloud host + deploy; run unattended.
6. Audience vote capture (unpin with real data).

## Open questions (answered by the spike)

- VIP **New Players** creates a fresh empty lobby with a new room code. The old
  room soon returns `nosuchroom`; old credentials cannot reclaim seats in the
  new room. The host agent publishes the replacement code and the loop rejoins
  every keeper and rotation pick as a fresh player.
- Player controllers expose the answers and player votes needed to reconstruct
  resolved matchups, but no score totals or standings. Arena computes scores
  from votes. A manually captured TV standings frame can be stored separately
  as `observed_scores` for audit.
- Exact Quiplash 3 timers with/without extended timers.

## Operating the lobby

Build the whole workspace before an unattended run:

```sh
pnpm build
```

The worker imports workspace packages through their `dist` exports, even when
the arena CLI itself is launched through `tsx`; stale or missing builds can
therefore run stale harness code.

Start components in this order:

1. Host agent: `pnpm --filter @quiparena/arena host-agent --room-file .data/room-code`
2. Web/API with the database store: `QUIPARENA_STORE=db pnpm --filter @quiparena/web dev`
3. Worker: `pnpm --filter @quiparena/arena cli loop --room CODE --room-file .data/room-code --ingest http://127.0.0.1:8787`

With `--ingest`, loop startup reads completed games from the web archive API so
the previous game's top two survive a worker restart. With `--db`, it reads the
same history directly and also abandons `running` games older than 30 minutes.
Completed archives created before vote-derived scoring are backfilled from
their resolved rows on DB-backed loop or ratings startup; API-backed seeding
computes the same fallback in memory. Ratings also run the stale-game sweep.
Abandoned games contribute no game-level wins, placements, points, or
appearance counts; already resolved matchup rows remain valid Bradley-Terry
comparisons.

The VIP chooses **New Players** after every game. Expect a new code and an empty
lobby; the host agent writes that code to the room file, and the worker waits
for the old room to disappear before using it. Do not reuse the old room's
credentials in the new lobby.

Audit a saved ecast recording without contacting Jackbox:

```sh
pnpm --filter @quiparena/jackbox replay --dir ./path/to/ecast --player-delay-ms 900
```

To attach TV ground truth later, run
`quiparena games capture-scores GAME_ID --image ./final-standings.png`; it
validates every displayed name and logs differences from computed scores.
