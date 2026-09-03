# @quiparena/jackbox

An ecast WebSocket client and Quiplash 3 seat harness. It drives the real
controller protocol while exposing only the small `Player` interface: answer a
prompt, answer Thriplash, and vote.

## Usage

```ts
import {
  EcastConnection,
  GameAggregator,
  Quiplash3Seat,
  lookupRoom,
} from "@quiparena/jackbox";

const room = await lookupRoom("ABCD");
const gameId = `ABCD-${Date.now()}`;
const publish = (event: import("@quiparena/core").AnyEvent) => {
  console.log(JSON.stringify(event));
};
const aggregator = new GameAggregator({ gameId, expectedPlayerCount: 4, onEvent: publish });
const connection = new EcastConnection({ room, name: player.name });
const seat = new Quiplash3Seat(connection, player, {
  gameId,
  defaultAnswerTimeoutMs: 60_000,
  defaultThriplashTimeoutMs: 60_000,
  defaultVoteTimeoutMs: 15_000,
  onEvent(event) {
    // game.ended from a seat is the VIP post-game signal. Publish the event
    // reconstructed by the aggregator instead of that signal.
    if (event.type !== "game.ended") publish(event);
    aggregator.ingest(event);
  },
});

await seat.connect();
```

Create one connection and seat per Player, give every seat the same `gameId`,
and feed all seat events to one `GameAggregator`. The aggregator emits
`matchup.resolved`, `thriplash.resolved`, and the public `game.ended`. It leaves
scores undefined because the player controller exposes no structured scores or
vote results.

`deadlineMs` on dealt/requested events is the configured duration. The
`PlayerContext.deadlineMs` passed into a Player remains an absolute wall-clock
deadline. State transition durations are written through the seat's `log`
callback as structured `harness.timing` records (or as JSON to stdout when no
logger is supplied).

The CLI supports room lookup, scripted play, reconnect, and offline recording
replay. Relative `--record`, `--credentials`, and `--dir` paths are resolved
from pnpm's original invocation directory (`INIT_CWD`) rather than the package
directory.

Audit a recording directory without contacting a live room:

```sh
pnpm --filter @quiparena/jackbox replay --dir ./packages/jackbox/recordings/VWIJ-1
```

The report shows gameplay states seen, actions sent, and any missed or
multiply-handled occurrences for each seat. Tests use loopback mock WebSocket
servers only.

## Verified against

- Real recordings: `client/welcome`, native `room` and `player:{id}` snapshots,
  lobby/character availability, entity updates, and request/reply correlation.
- Real eight-seat game `VWIJ-1` with extended timers: round 1 answer window
  about 90 seconds, vote window about 25 seconds, and round 2 answer window
  about 94 seconds. Its controller reused `choiceId: "ChoseQuip"` for every
  matchup and restarted `entryId` at `WriteQuips:0` in round 2.
- Current jackbox.tv Quiplash 3 controller source: room/player projection and
  aliases; all routed controller states; truthy `entry`/`entries` and
  non-null/nonempty `chosen` completion; `{text}`/`{html}` display values;
  character/start/cancel/answer/Thriplash/vote/post-game/safety-quip sends;
  key-or-position vote identifiers; reload versus same-page reconnect
  parameters; immediate-first retry/backoff; and absence of a JavaScript
  keepalive, numeric controller timer, or player-visible result model.
- Still needs an authorized live-game confirmation: the exact duplicate-answer
  wording/validation behavior, a concrete runtime Thriplash `fieldCount`, and
  what happens to the room and existing sockets after `PostGame_NewGame` (New
  Players).

Do not point automated tests at a live room. Secrets are bearer credentials and
must not be logged.
