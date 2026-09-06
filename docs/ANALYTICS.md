# Saved analytics

The web server owns the PGlite connection. Rating refreshes load comparisons through that connection and send plain data to a Node worker thread. The worker fits the standard, cross-family, and family-balanced views for player, audience, and blended voting, preserving game-cluster bootstrap intervals. All nine results and their statistics are published in one transaction. Leaderboard requests read these snapshots and current model metadata; they never fit ratings or reconstruct historical statistics.

Refreshes run after game completion, at startup, on the existing five-minute housekeeping interval, and through the authenticated ratings-recompute endpoint. DbStore serializes refreshes. Readers retain the previous completed snapshots during a refresh. Shutdown drains ingestion and pending analytics before closing PGlite. A worker failure leaves the previous snapshots intact.

Frontier stores one `game_analytics` row per closed game (completed, abandoned, or failed). Each row contains per-model cost, priced-trace count, answer count, latency/reasoning sums and counts, and wins/played for each vote population. Active games enter frontier totals when closed. The existing handling of abandoned games' resolved matchups is preserved. Means are calculated from combined sums/counts, never means of game averages. Unpriced calls remain unknown rather than free.

Startup backfills missing aggregate rows. Existing rows are reused, including across restarts and scoring-season resets; reads select the current season and honor excluded-game settings. Raw events, traces, answers, and votes are preserved. If aggregation semantics ever change, bump `AGGREGATE_VERSION` in `apps/web/server/frontier.ts` to explicitly rebuild derived rows at refresh time. Ordinary operation does not restate closed games.

The games archive and model-history pagination are unchanged.

## Validation (2026-09-06, local production data)

Single-request samples before/after:

| Endpoint | Before | After |
| --- | ---: | ---: |
| Standard leaderboard | 78 ms | 6 ms |
| Cross-family leaderboard | 3,126 ms | 4 ms |
| Family-balanced leaderboard | 3,538 ms | 4 ms |
| Frontier | 218 ms | 7 ms |

During a 17.2-second background refresh, 84 concurrent health requests had a median of 1 ms and maximum of 10 ms. Previously a concurrent health request waited 6.8 seconds. These are local spot measurements, not latency guarantees. Frontier aggregates matched the old calculation within floating-point rounding. Tests cover all nine snapshots, aggregate persistence/idempotence, weighted latency across unequal game counts, season resets, and reads without raw trace/vote history.
