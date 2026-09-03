# Quiplash 3 audience role

This note records what a non-voting audience connection could see in a live,
eight-player Quiplash 3 game on September 2, 2026. The read-only connection
joined `TZOQ` at the start of play, stayed through `room/exit`, and followed the
room-code file to `XBBN` in time to record its lobby. It never sent an ecast
request, vote, or gameplay action.

The complete captures are:

- `spike/recordings/audience-TZOQ-2026-09-03T04-25-22-422Z.jsonl` (one full
  game, 155 inbound frames over 13 minutes 42 seconds);
- `spike/recordings/audience-XBBN-2026-09-03T04-39-27-478Z.jsonl` (the next
  game, beginning in the lobby and still recording when this note was written).

Each line is `{t, dir, data}`. `t` is Unix time in milliseconds, `dir` is `in`,
and `data` is the exact WebSocket payload. The welcome frame contains a live
reconnect secret, so recordings must be treated as credentials while their room
exists. Secrets below are redacted.

## Connection and handshake

Look up the room at `GET
https://ecast.jackboxgames.com/api/v2/rooms/{CODE}`. An audience connection must
use the returned `audienceHost`, not the player `host`, and must use the
audience path:

```text
wss://{audienceHost}/api/v2/audience/{CODE}/play
  ?role=audience
  &name=AUDIENCE
  &format=json
  &user-id={STABLE_UUID}
```

The WebSocket subprotocol is `ecast-v0`. The spike also sends browser-like
`Origin: https://jackbox.tv` and `Referer: https://jackbox.tv/` headers. The
current controller has no `audienceHost`-to-`host` fallback, so the recorder
also refuses to fall back. This differs from a player connection in host
selection (`audienceHost` rather than `host`), path (`audience` rather than
`rooms`), and `role`. Both host fields happened to name the same server in
these two rooms, but clients must not assume that.

The interactive site sanitizes and uppercases names. `AUDIENCE` worked as the
query name and was returned unchanged by the live server. The server assigned
an audience-range id and returned neither a player profile nor a presence map:

```json
{
  "pc": 777,
  "opcode": "client/welcome",
  "result": {
    "id": 10000001594,
    "name": "AUDIENCE",
    "secret": "[redacted]",
    "reconnect": false,
    "entities": {
      "audience": ["audience/pn-counter", { "key": "audience", "count": 0 }, { "locked": false }],
      "audiencePlayer": ["object", { "key": "audiencePlayer", "val": "<trimmed>" }, { "locked": false }],
      "room": ["object", { "key": "room", "val": "<trimmed>" }, { "locked": false }]
    },
    "here": null,
    "profile": null
  }
}
```

Only `audience`, `audiencePlayer`, and `room` were observed. No `player:{id}`,
`bc:*`, or `tv` entity was delivered during the full game. The
`packages/jackbox` `EcastConnection` cannot be reused as-is: it selects
`room.host`, `/api/v2/rooms/...`, and `role=player` unconditionally. The spike
therefore uses a separate, audience-only socket.

For an abnormal reconnect to the same room, retain `user-id` and add the
welcome's `id`, `secret`, and `deviceId` as `id`, `secret`, and `device-id` on
the same audience URL. A new code is a new room and gets a fresh connection and
recording.

## State by phase

Audience rendering is a projection, not simply `room.state`. The controller
merges shared room data with `audiencePlayer.audience`, falling back to
`room.audience`; audience fields win. Consequently the wire can contain an
outer `state: "Lobby"` while the audience UI renders the nested
`state: "Logo"`.

### Lobby

The audience receives shared lobby data such as `characters`,
`gameCanStart`, `gameIsStarting`, `gameFinished`, `lobbyState`, and localized
strings. It does not receive player entities or a named roster. Character
availability changes and lobby flags make player joins and the countdown
observable indirectly. Its nested audience state is a passive `Logo` with a
wait message:

```json
{
  "key": "audiencePlayer",
  "val": {
    "audience": {
      "message": { "html": "You’re in the audience. Please wait for the game to start" },
      "state": "Logo"
    },
    "characters": [
      { "available": true, "name": "Purple" },
      { "available": true, "name": "Blue" }
    ],
    "gameCanStart": false,
    "gameFinished": false,
    "gameIsStarting": false,
    "lobbyState": {},
    "state": "Lobby",
    "strings": "<trimmed>"
  }
}
```

As the eighth player joined, `room.lobbyState` became `"CanStart"` and
`gameCanStart` became `true`; starting changed it to `"Countdown"` with
`gameIsStarting: true`. These fields do not give the audience any lobby action.

The welcome's `audience` PN-counter was `0` even though this connection was
active, and no update to that counter followed. It is not a reliable audience
connection total for this use case.

### Normal-round answering

The audience stays in `Logo` and receives no player prompt, answer-entry key,
draft answer, or completion state. The only phase-specific presentation is the
wait message:

```json
{
  "opcode": "object",
  "result": {
    "key": "audiencePlayer",
    "val": {
      "audience": {
        "message": {
          "html": "You’re in the audience. Please wait for the players to complete their tasks."
        },
        "state": "Logo"
      },
      "state": "Logo",
      "textDescriptions": []
    },
    "version": 6,
    "from": 1
  }
}
```

### Normal-round voting

For every matchup, `audiencePlayer.audience` becomes
`MakeSingleChoice` and supplies the prompt and both answers. Normal-round choice
keys were `left` and `right`:

```json
{
  "key": "audiencePlayer",
  "val": {
    "audience": {
      "choiceId": "VoteForQuipRound",
      "choices": [
        { "html": "FOLD A FITTED SHEET WITHOUT CRYING", "key": "left" },
        { "html": "NO COMMENT", "key": "right" }
      ],
      "prompt": {
        "html": "There’s nothing sexier than a tall, beefy boy who knows how to _______<br /><br />Vote for your favorite"
      },
      "state": "MakeSingleChoice",
      "toggle": false,
      "type": "single"
    },
    "state": "MakeSingleChoice"
  },
  "version": 8,
  "from": 1
}
```

Immediately after each choice frame, the audience also received the aggregate
count group:

```json
{
  "pc": 514,
  "opcode": "audience/count-group",
  "result": {
    "key": "quiplash3 Vote",
    "choices": { "left": 0, "right": 0 }
  }
}
```

All counts stayed at zero because the recorder abstained and no other audience
vote was observed. The count group is structured audience-vote data; it is not
the player vote breakdown.

### Matchup results and round standings

After voting, `audiencePlayer.audience` returns to `Logo`. The `room` entity
then narrates each quip and the resolved result in accessibility
`textDescriptions`. Results were winner plus percentage, a tie, and sometimes
an additional Quiplash sentence:

```json
{
  "opcode": "object",
  "result": {
    "key": "room",
    "val": {
      "audience": { "state": "Logo" },
      "state": "Logo",
      "textDescriptions": [
        {
          "category": "Vote",
          "id": 309,
          "text": "\"FOLD A FITTED SHEET WITHOUT CRYING\" by GPT-5.6 LUNA got a quiplash with 100 percent of the vote."
        }
      ]
    },
    "version": 29,
    "from": 1
  }
}
```

Other literal result forms were:

```json
{ "category": "Vote", "id": 316, "text": "The winning quip is \"RAGE AGAINST THE PRINTER\" by MINIMAX M3 with 83 percent of the vote." }
{ "category": "Vote", "id": 319, "text": "GEMINI PRO and GROK 4.6 tied!" }
```

Thus matchup winner/tie and percentage are visible and machine-parseable, but
only as English narration. Exact player vote counts, voter identities, and
per-matchup score awards/deltas were not delivered.

At the end of rounds one and two, `textDescriptions` contained a complete,
ordered score list:

```json
[
  { "category": "Score", "id": 333, "text": "GPT-5.6 LUNA is first with 2180 points." },
  { "category": "Score", "id": 334, "text": "QWEN 3.8 MAX is second with 1430 points." },
  "<six more players>"
]
```

These are total scores at the scoreboard, not a structured score object and not
a score update after each matchup.

### Thriplash

Thriplash entry looks like normal answering to the audience: `Logo`, the same
wait message, and no prompts or drafts. A preceding audience update carried
`classes: ["Round2"]`, but that label alone is not a dependable phase contract.

Thriplash voting is still `MakeSingleChoice`. The differences observed were
`choiceId: "VoteForQuip"`, numeric-string keys `"0"` and `"1"`, and
three newline-separated answers in each choice:

```json
{
  "choiceId": "VoteForQuip",
  "choices": [
    {
      "disabled": false,
      "html": "DOG TAIL THUMPING ON THE FLOOR\nWIFI RECONNECTING AFTER A DROP\nTODDLER TRYING TO PUT ON SHOES",
      "key": "0"
    },
    {
      "disabled": false,
      "html": "A PUG IN A RAINCOAT\nOLD MEN SLOW DANCING\nTODDLER YELLING I LOVE YOU",
      "key": "1"
    }
  ],
  "prompt": {
    "html": "Three things that’ll melt your heart EVERY. DANG. TIME.<br /><br />Vote for your favorite"
  },
  "state": "MakeSingleChoice",
  "toggle": false,
  "type": "single"
}
```

Its count group used the same key with numeric-string choice buckets:

```json
{ "key": "quiplash3 Vote", "choices": { "0": 0, "1": 0 } }
```

Thriplash result narration had the same winner/tie/percentage shape as normal
rounds.

### Final results and post-game

After the last matchup, the audience received all eight final rankings and
scores, followed by a separate winner description:

```json
[
  { "category": "Score", "id": 396, "text": "GEMINI PRO is first with 9680 points." },
  { "category": "Score", "id": 397, "text": "GROK 4.6 is second with 8790 points." },
  "<six more players>"
]
```

```json
{ "category": "Winner", "id": 404, "text": "The winner is GEMINI PRO with 9680 points." }
```

The `room` entity also exposed the game artifact. It finally returned to a
shared post-game lobby, while the nested audience projection remained passive:

```json
{
  "artifact": {
    "artifactId": "2f7cedf0c6b357a7faa88d87df92fb81",
    "categoryId": "quiplash3Game",
    "rootId": "jbg-blobcast-artifacts"
  },
  "audience": { "state": "Logo" },
  "gameCanStart": true,
  "gameFinished": true,
  "gameIsStarting": false,
  "lobbyState": "PostGame",
  "state": "Lobby",
  "textDescriptions": []
}
```

The audience received no post-game choice UI. When the automation chose a new
player game, the last frame was:

```json
{ "pc": 3588, "opcode": "room/exit", "result": { "cause": 5 } }
```

The old code then disappeared from the room directory and the room-code file
changed from `TZOQ` to `XBBN`.

## How an audience vote is sent

The controller does not use player `client/send`/`choose`. When the audience
state is `MakeSingleChoice`, it sends one count-group increment:

```json
{
  "seq": 1,
  "opcode": "audience/count-group/increment",
  "params": {
    "name": "quiplash3 Vote",
    "vote": "left",
    "times": 1
  }
}
```

Use the runtime `countGroupName` when supplied and stringify the selected
choice key. In this trace the state omitted `countGroupName`; the official
controller's fallback-derived name, confirmed by every received count-group
entity, was `quiplash3 Vote`. Code should preserve/derive the runtime name and
must not assume it is a universal constant. The spike did **not** send this
request.

## Count-group fetch spike

A follow-up read-only probe joined `ZSAX` as a separate audience member and
sent only the controller's count-group `get` request. The exact first request
and correlated response during a live vote window were:

```json
{"seq":1,"opcode":"audience/count-group/get","params":{"name":"quiplash3 Vote"}}
{"pc":0,"re":1,"opcode":"audience/count-group","result":{"key":"quiplash3 Vote","choices":{"left":0,"right":0}}}
```

It repeated the read once per second during that window. All eleven live-window
replies were zero. At the transition out of voting it sent:

```json
{"seq":12,"opcode":"audience/count-group/get","params":{"name":"quiplash3 Vote"}}
{"pc":0,"re":12,"opcode":"audience/count-group","result":{"key":"quiplash3 Vote","choices":{"left":0,"right":0}}}
```

The game then narrated 67 percent for the winner, which is consistent with four
of the six eligible player votes and no audience contribution. Thus production
accepts audience-role count-group reads, but this probe did not establish that
they expose a nonzero vote from another audience connection. The literal
request/reply capture is
`spike/recordings/audience-fetch-ZSAX-2026-09-03T05-49-41-488Z.jsonl`.

`AudienceObserver` now repeats this read approximately once per second while a
vote is active and once more on the transition out of the vote window. It never
sends `audience/count-group/increment`.

Until a nonzero fetch is observed, the recorder infers Quiplash's aggregate
audience unit from narrated result percentages and the complete player ballot.
It first tests whether the rounded percentages fit the player votes alone. If
not, it adds whole audience units to the side whose observed share increased
and chooses the smallest total vote count whose rounded shares match. A direct
nonzero count-group result supersedes that inference.

## Recommendation

1. **Per-matchup results: yes, with qualifications.** The audience gives the
   prompt, both candidate answers, winner or tie, and narrated percentage. It
   does not give structured player vote counts, voter identities, or
   per-matchup points. It gives full score totals only at round scoreboards. An
   audience-based recorder can therefore capture matchup outcomes and periodic
   scores, but cannot produce authoritative per-matchup score deltas without an
   additional source or inference.
2. **Final standings: yes.** All eight ordered names and totals, plus the winner
   and winning total, were visible in `textDescriptions`. Parsing English
   accessibility strings is less robust than a structured contract, so retain
   raw frames and alert on unparseable/localized forms.
3. **Human audience-vote counts: yes per poll, not as a general population
   count.** `audience/count-group.result.choices` exposes a bucket for every
   answer. For ordinary single-choice Quiplash voting, summing those buckets
   gives the number of audience vote submissions in that matchup. All buckets
   were zero in this no-vote trace, so delivery of a non-zero update to a
   passive observer remains unverified live even though the protocol and
   controller model these as aggregate counters. The values do not identify
   voters, distinguish humans from other audience clients, include connected
   non-voters, or reliably report total audience connections. The observed
   `audience` PN-counter cannot fill that gap; the authoritative connection
   count is the host-only `room/get-audience` operation.

No `bc:*` or `tv` entity appeared, so neither should be part of the recorder's
required schema.

## What moderator mode would add

The live room advertised `moderationEnabled: false`, so no moderator connection
was attempted. The current official moderator client requires all of:

- Quiplash 3's host-side **Moderation** setting enabled, followed by a game
  restart so room lookup reports `moderationEnabled: true`;
- the four-letter room code and the game's five-digit moderator password;
- a connection to `room.host` on the normal room path with `role=moderator`,
  `name=moderator`, `password=...`, `format=json`, and subprotocol `ecast-v0`.

In schematic form:

```text
wss://{host}/api/v2/rooms/{CODE}/play
  ?role=moderator
  &name=moderator
  &password={FIVE_DIGIT_PASSWORD}
  &format=json
```

Moderator mode adds pending `moderate:{type}:...` entities containing submitted
content, submitter name, status, and optional prompt context. Its UI can approve
or reject those objects and notify the host. The Quiplash 3 manifest advertises
moderation but not the moderator client's separate player-kicking feature.

That is useful for inspecting answers before they reach the TV, but it is not a
scoreboard role: the static moderator client supplies no contract for resolved
votes, scores, standings, or a winner. Even when enabled, it should complement
the audience recorder for content moderation, not replace it for results.
