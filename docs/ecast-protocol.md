# Jackbox ecast v2 protocol notes for Quiplash 3

This document describes the wire protocol needed by a Quiplash 3 player or
audience client. It is prior-art research, not an official Jackbox
specification. No live room was contacted while preparing it.

The highest-confidence evidence is the public Quiplash 3 web-controller bundle,
cross-checked against independent clients. Private ecast servers are useful for
understanding server-side routing and ACLs, but their authors explicitly leave
some behavior unimplemented, so this document does not treat them as normative.
In JSON examples, uppercase values such as `PLAYER_ID`, `TEXT_KEY`, and
`CHOICE_INDEX` are placeholders supplied at runtime.

## Source corpus and confidence convention

Source paths in citations are relative to the scratch clone directory
`priorart/`. Links are pinned to the revisions examined.

| Source | Revision date | Revision | How it is used |
| --- | --- | --- | --- |
| `JackboxGPT3` | 2021-12-03 | `ba8ade3` | C# ecast v2 and Quiplash 3 player implementation |
| `jackbox` | 2020-05-13 | `36388b0` | Historical Go API v1 implementation; useful only as a contrast |
| `johnbox` | 2024-05-23 | `69ec98e` | Node private ecast server; entity, ACL, and request handling |
| `jackbox-bot` | 2020-10-25 | `3bd82f3` | Historical Socket.IO/Blobcast client; not ecast v2 |
| `jackboxgamesapi` | 2023-02-26 | `a5d2b72` | Python ecast v2 host connection |
| `jackbox-int-tv` | 2024-05-24 | `8bcbf04` | Public mirror of the Quiplash 3 web-controller bundle |
| `rolando` | 2026-05-18 | `17cf2a9` | Go ecast v2/Quiplash 3 player implementation |
| `ai-plays-jackbox` | 2026-05-06 | `b79cbe0` | Python ecast v2/Quiplash 3 player implementation |
| `localbox` | 2026-07-26 | `40787ba` | Node private server implementation |
| `jonahbox` | 2026-05-12 | `7656050` | Rust private server and proxy implementation |
| `JackboxGPT` | 2023-09-13 | `73d8e71` | JavaScript Quiplash 3 bot and timing workarounds |
| `Quipbot` | 2023-03-18 | `5022f66` | Browser-DOM Quiplash 3 state observer |
| `jackboxapi-re` | 2024-08-13 | `1bbb6d3` | Reverse-engineering notes and recorded audience examples |

“High confidence” below means an exact value or frame appears in the public
controller and at least one independent implementation. “Medium” means sources
agree but one side is inferred or implemented by a private server. “Low” means
the available source is incomplete or contradictory.

GitHub searches for `ecast-v0`, `/api/v2/audience`, and `quiplash3`, including
language-filtered TypeScript searches, found current Go, Python, JavaScript, and
Rust implementations but no TypeScript ecast client. The TypeScript design at
the end is therefore a recommendation, not a description of another library.

## 1. Room lookup

Normalize the code to uppercase and request:

```http
GET https://ecast.jackboxgames.com/api/v2/rooms/{CODE}
```

The response envelope is:

```json
{
  "ok": true,
  "body": {
    "appId": "...",
    "appTag": "quiplash3",
    "audienceEnabled": true,
    "code": "ABCD",
    "host": "ecast-host.example",
    "audienceHost": "ecast-audience-host.example",
    "locked": false,
    "full": false,
    "maxPlayers": 8,
    "minPlayers": 3,
    "moderationEnabled": false,
    "passwordRequired": false,
    "twitchLocked": false,
    "locale": "en",
    "keepalive": true,
    "controllerBranch": "..."
  }
}
```

Not every field is guaranteed to be present. In particular, older models omit
`audienceHost`, `minPlayers`, `maxPlayers`, and `controllerBranch`. The current
public controller maps all of the fields shown above, and the newer Go client
does the same ([`jackbox-int-tv/main/pp7/quiplash3/script.js:12799`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L12799-L12893),
[`rolando/internal/jackbox/ecast_room.go:13`](https://github.com/LJS360d/rolando/blob/17cf2a9c9254b33dcc84745bf9fa269f1e6b495e/internal/jackbox/ecast_room.go#L13-L35)).
Treat `ok: false`, a missing `body`, or a missing `body.host` as a failed lookup;
the Go implementation also handles JSON 404s and HTML error pages explicitly
([`rolando/internal/jackbox/ecast_room.go:38`](https://github.com/LJS360d/rolando/blob/17cf2a9c9254b33dcc84745bf9fa269f1e6b495e/internal/jackbox/ecast_room.go#L38-L83)).
The Party Pack 7 game tag is `quiplash3`; the standalone Starter build is
`quiplash3-tjsp`. Support both only if QuipArena intends to target both builds
([`jackboxgamesapi/appTags.py:14`](https://github.com/Pinball3D/jackboxgamesapi/blob/a5d2b7218df85c5dac1c4dad20a2ccb32c143ce4/appTags.py#L14-L18)).

Use the returned `host` for a player socket. Do not assume that the directory
host is also the play host. Use `audienceHost` for an audience socket when it is
present, falling back to `host` only when it is absent. JackboxGPT3 performs the
same v2 lookup but its original socket configuration uses a configured ecast
host rather than `body.host`; newer clients corrected that
([`JackboxGPT3/src/Startup.cs:44`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Startup.cs#L44-L65),
[`JackboxGPT/index.js:27`](https://github.com/Electric131/JackboxGPT/blob/73d8e716034b38d6151a6aae54ac503d9e1da56f/index.js#L27-L46)).

The old Go `jackbox` SDK calls the pre-v2 `/room/{code}` API and models fields
such as `server`, `joinAs`, and `numAudience`; those names must not be copied
into an ecast v2 implementation
([`jackbox/room_info.go:21`](https://github.com/kklash/jackbox/blob/36388b066b01bbe31df0c0694f2226c3cbfad472/room_info.go#L21-L49)).

**Confidence: high** for the endpoint, envelope, and `host`; **medium** for which
optional lookup fields are always returned.

## 2. WebSocket connection and welcome

### New player

Connect to the lookup result with an ordinary WebSocket and request the single
subprotocol `ecast-v0`:

```text
wss://{body.host}/api/v2/rooms/{CODE}/play
  ?role=player
  &name={URL_ENCODED_DISPLAY_NAME}
  &format=json
  &user-id={STABLE_UUID}
```

The query name is exactly `user-id`, not `userId`. Add `password=...` when the
room requires it. The public controller can also send `device-id` and
`twitch-token`. A non-browser implementation may need browser-compatible
`Origin: https://jackbox.tv` and `Referer: https://jackbox.tv/` headers; the 2026
Go client supplies them, though the sources do not establish that the service
always requires them
([`rolando/internal/jackbox/ecast_play.go:26`](https://github.com/LJS360d/rolando/blob/17cf2a9c9254b33dcc84745bf9fa269f1e6b495e/internal/jackbox/ecast_play.go#L26-L60),
[`JackboxGPT3/src/Games/Common/Models/BootstrapPayload.cs:5`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Common/Models/BootstrapPayload.cs#L5-L25)).

### Welcome snapshot

The first useful notification is normally shaped as follows:

```json
{
  "pc": 1,
  "opcode": "client/welcome",
  "result": {
    "id": 2,
    "name": "ALICE",
    "secret": "SERVER_ISSUED_SECRET",
    "reconnect": false,
    "deviceId": "SERVER_ISSUED_DEVICE_ID",
    "entities": {
      "room": [
        "object",
        { "key": "room", "val": {}, "version": 0, "from": 1 },
        { "locked": false }
      ]
    },
    "here": {},
    "profile": {
      "id": 2,
      "roles": { "player": { "name": "ALICE" } }
    }
  }
}
```

`id` is the ecast connection/player id and is the number used in
`player:{id}`, `from`, and usually the host's `to`. `secret` and `deviceId` are
server-issued reconnection credentials. `entities` is an ACL-filtered snapshot,
not merely metadata: apply it before processing later deltas. Each entry is a
three-element tuple of entity type, entity payload, and metadata such as
`locked`. `here` is a presence map and `profile` describes the current client.
The public controller consumes all of these fields; johnbox emits this tuple
form and filters the snapshot by entity ACL
([`jackbox-int-tv/main/pp7/quiplash3/script.js:13961`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L13961-L13977),
[`johnbox/johnbox.js:451`](https://github.com/InvoxiPlayGames/johnbox/blob/69ec98e92226168d8fd11c4dbbe4de21fae6b2e1/johnbox.js#L451-L508)).

The example values and presence contents above are illustrative. Host id `1`
is a reliable convention in these clients and private servers, but a robust
client should find the member whose `roles` contains `host`, falling back to
`1`; the public controller does exactly that
([`jackbox-int-tv/main/pp7/quiplash3/script.js:30743`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30743-L30751),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:30807`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30807-L30814)).

### Reconnect

Persist the original `user-id` and the welcome's `id`, `secret`, and
`deviceId`. Reconnect to the same role-specific path and add them to the query:

```text
?id={PLAYER_ID}
&role=player
&name={URL_ENCODED_DISPLAY_NAME}
&format=json
&user-id={ORIGINAL_UUID}
&device-id={DEVICE_ID}
&secret={SECRET}
```

On success, `client/welcome.result.reconnect` is `true`, the identity is
retained, and the new welcome snapshot is the source of truth. The public
controller persists a compact `id:role:secret` reconnect string and routes an
id over 10,000,000 back to the audience endpoint
([`jackbox-int-tv/main/pp7/quiplash3/script.js:14169`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L14169-L14217),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:30743`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30743-L30751)).
Treat `secret` as a bearer credential and do not log it.

The exact server-side expiry and validation rules for reconnect secrets are not
established by these sources. Both johnbox and localbox acknowledge gaps in
their reconnect implementations, so they are not evidence for those rules.

### Other roles

Audience connection is covered in section 6. For reference, an ecast host uses
the room path with `role=host`, `format=json`, and `host-token={token}`; the
Python host implementation demonstrates the exact form
([`jackboxgamesapi/host.py:20`](https://github.com/Pinball3D/jackboxgamesapi/blob/a5d2b7218df85c5dac1c4dad20a2ccb32c143ce4/host.py#L20-L23)).

**Confidence: high** for the player URL, query spelling, subprotocol, welcome
fields, and reconnect query; **medium** for server-side reconnect lifetime and
header requirements.

## 3. Frames, opcodes, and entity keys

### The two envelopes

It is easy to conflate the directions. A client request uses `seq` and
`params`:

```json
{ "seq": 1, "opcode": "text/update", "params": { "key": "...", "val": "..." } }
```

A server notification uses `pc` and `result`:

```json
{ "pc": 12, "opcode": "object", "result": { "key": "room", "val": {}, "version": 3, "from": 1 } }
```

A reply adds `re`, whose value is the request's `seq`:

```json
{ "pc": 13, "re": 1, "opcode": "ok", "result": {} }
```

Thus `{seq, opcode, result}` is not an actual ecast v2 envelope: `seq` pairs
with `params` client-to-server, while `pc` pairs with `result`
server-to-client. The public controller distinguishes replies by `re`, keeps a
promise table keyed by request sequence, and increments `seq` before every send
([`jackbox-int-tv/main/pp7/quiplash3/script.js:14099`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L14099-L14111),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:14269`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L14269-L14299)).
`pc` is a server-side stream position/cursor; it is not the client's request
sequence.

### Relevant opcode families

| Opcode | Direction in a player client | Meaning |
| --- | --- | --- |
| `client/welcome` | server to client | Identity, reconnect credentials, presence, and initial entity snapshot |
| `client/send` | client to host; server forwards to host | Game action message; Quiplash uses it for avatar, start, vote, and post-game actions |
| `client/connected` / `client/disconnected` | server to host | Presence notifications; ordinary players should not depend on receiving them |
| `object`, `text`, `number` | server to authorized clients | Entity snapshot/delta result with `key`, `val`, `version`, and `from` (number may add restrictions) |
| `object/update`, `text/update`, `number/update` | client to server | Mutate an existing writable entity; Quiplash answers use `text/update` |
| `object/create`, `text/create`, `number/create` | normally host to server | Create an entity with value and ACL |
| `object/set`, `text/set`, `number/set` | client to server when authorized | Set/create-style mutation; not needed by a Quiplash player |
| `object/get`, `text/get`, `number/get` | client to server | Request the current entity; normal clients can rely on snapshot plus deltas |
| `lock` | either request or notification | Lock an entity; the notification result identifies `key` and `from` |
| `drop` | either request or notification | Remove an entity by `key` |
| `room/lock`, `room/exit` | server notification; host request | Stop new joins or close the room |
| `room/get-audience` | host request/reply | Returns `{connections: number}` |
| `ok`, `error` | server reply | Completes/rejects the request identified by `re` |
| `audience/count-group/*` | audience/host requests and server results | Create, increment, and fetch aggregated vote buckets |

The controller's result decoder includes these plus doodle, stack, text-map,
and other game-generic families
([`jackbox-int-tv/main/pp7/quiplash3/script.js:13910`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L13910-L14095)). A modern Rust server's request enum independently documents the create,
set, update, get, counter, `client/send`, room, `lock`, and `drop` parameter
families
([`jonahbox/src/ecast/ws.rs:120`](https://github.com/StratusFearMe21/jonahbox/blob/765605084fc3e85f3c4e0e523b827c46fe053dc9/src/ecast/ws.rs#L120-L337)).

### Quiplash 3 entity keys

| Key | Entity type | Use in Quiplash 3 |
| --- | --- | --- |
| `room` | normally `object` | Shared controller state, including lobby characters and room-wide fields |
| `player:{PLAYER_ID}` | normally `object` | Private/per-player state machine: prompt, writable text key, choices, VIP flags, and done markers |
| `entertext:{PLAYER_ID}` | `text` | Common answer entity name, but use the exact `player.textKey` supplied by the game |
| `textDescriptions` | `object` | Accessibility descriptions recognized by the public controller |
| `audiencePlayer` | object or JSON text | Audience-specific state merged with `room.audience` |
| `player` | object or JSON text | Generic unsuffixed compatibility form recognized by the controller |
| `bc:room` | JSON `text` or object | Legacy Blobcast-compatible room state, not Quiplash 3's primary key |
| `bc:customer:{USER_ID}` | JSON `text` or object | Legacy Blobcast-compatible player state, keyed by UUID rather than ecast id |

JackboxGPT3's Quiplash 3 client explicitly selects `room` and `player:` while a
different base class handles `bc:room` and `bc:customer:` games
([`JackboxGPT3/src/Games/Common/PlayerSerializedClient.cs:6`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Common/PlayerSerializedClient.cs#L6-L12),
[`JackboxGPT3/src/Games/Common/BcSerializedClient.cs:6`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Common/BcSerializedClient.cs#L6-L18)). The public controller recognizes all of these compatibility forms and the exact key
`textDescriptions`
([`jackbox-int-tv/main/pp7/quiplash3/script.js:30753`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30753-L30796)).

No examined Quiplash 3 player source recognizes `textDescriptions:*`; only the
unqualified `textDescriptions` key is established. Likewise, the examined
player sources do not establish a `tv` key or its schema. A host may create
additional ACL-scoped entities, including a TV-only model, but a player client
must neither subscribe to nor infer access to them. Entity visibility comes
from the welcome snapshot and later authorized deltas, not from a naming rule.

**Confidence: high** for the envelopes, main opcodes, and `room`/`player:`/
`entertext:` keys; **medium** for the complete generic opcode semantics;
**low/unknown** for `tv` and any `textDescriptions:*` variant.

## 4. Quiplash 3 player state machine

Quiplash 3 sends controller state primarily by replacing the `val` of `room`
and `player:{id}`. Treat every object as an evolving schema and preserve unknown
fields. The public controller merges shared room data with the current player
object before choosing a layout
([`jackbox-int-tv/main/pp7/quiplash3/script.js:30442`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30442-L30463)).

All `client/send` actions below use this outer frame:

```json
{
  "seq": 1,
  "opcode": "client/send",
  "params": {
    "from": 2,
    "to": 1,
    "body": {}
  }
}
```

Substitute the current player id for `from`, the host id from `here` for `to`,
and the per-connection next sequence for `seq`.

### Lobby and character selection

Relevant received fields include:

```json
{
  "state": "Lobby",
  "characters": [
    { "name": "CHARACTER_NAME", "available": true }
  ],
  "playerInfo": { "avatar": "...", "username": "..." },
  "playerIsVIP": false,
  "gameCanStart": false,
  "playerCanStartGame": false,
  "gameIsStarting": false,
  "gameFinished": false
}
```

`characters` is commonly shared room state. Pick only an item with
`available: true`, then send:

```json
{
  "seq": 1,
  "opcode": "client/send",
  "params": {
    "from": 2,
    "to": 1,
    "body": { "action": "avatar", "name": "CHARACTER_NAME" }
  }
}
```

The C# client and public controller agree on the exact body
([`JackboxGPT3/src/Games/Quiplash3/Quiplash3Client.cs:13`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Quiplash3/Quiplash3Client.cs#L13-L17),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:27312`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L27312-L27318)). Send once per actual selection; do not copy the older JavaScript bot's one-second
avatar loop
([`JackboxGPT/index.js:54`](https://github.com/Electric131/JackboxGPT/blob/73d8e716034b38d6151a6aae54ac503d9e1da56f/index.js#L54-L85)).

### VIP: “Everybody's In”

Show/enable start only when the merged state says the player is VIP and the
game permits it: `playerIsVIP`, `gameCanStart`, and `playerCanStartGame` true,
with `gameIsStarting` false. Send:

```json
{
  "seq": 2,
  "opcode": "client/send",
  "params": {
    "from": 2,
    "to": 1,
    "body": { "action": "start" }
  }
}
```

“Everybody's In” is the button label; `start` is the wire action. The public
controller builds that action from the lobby flags, and the 2026 Go client
independently sends it
([`jackbox-int-tv/main/pp7/quiplash3/script.js:26926`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L26926-L26977),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:27116`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L27116-L27135),
[`rolando/internal/jackbox/games/quiplash3.go:124`](https://github.com/LJS360d/rolando/blob/17cf2a9c9254b33dcc84745bf9fa269f1e6b495e/internal/jackbox/games/quiplash3.go#L124-L154)).

### Normal rounds: prompt and answer

Both normal rounds reuse `state: "EnterSingleText"`; there is no different
send format for round one versus round two. A typical per-player value contains:

```json
{
  "state": "EnterSingleText",
  "entryId": "RUNTIME_ENTRY_ID",
  "prompt": { "html": "<div class='header'>Prompt 1 of 2</div><div>...</div>" },
  "textKey": "entertext:2",
  "maxLength": 45,
  "entry": null,
  "doneText": ""
}
```

The prompt and header are HTML. Sanitize/extract text for an agent rather than
passing markup blindly. `maxLength` is state supplied; obey it instead of
hard-coding 45. Submit an answer by updating the exact `textKey`:

```json
{
  "seq": 3,
  "opcode": "text/update",
  "params": {
    "key": "entertext:2",
    "val": "THE ANSWER"
  }
}
```

The controller routes a local `write` action with a `textKey` to `text/update`,
and both the C# and Go clients send the same mutation
([`jackbox-int-tv/main/pp7/quiplash3/script.js:31154`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L31154-L31204),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:30552`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30552-L30568),
[`rolando/internal/jackbox/games/quiplash3.go:156`](https://github.com/LJS360d/rolando/blob/17cf2a9c9254b33dcc84745bf9fa269f1e6b495e/internal/jackbox/games/quiplash3.go#L156-L207)).

If a generic `EnterSingleText` state lacks `textKey`, the public controller's
fallback is a host message with body `{ "action": "write", "entry": "THE
ANSWER" }`. The examined Quiplash 3 clients expect a writable text key, so this
fallback is **uncertain for Quiplash 3** and should not replace the normal path.

After acceptance, a later player object sets `entry` to a non-null value and/or
provides `doneText`; the controller then hides the form and displays the done
view. There is no separate “you're done” request. A new `entryId` can introduce
the next assigned prompt even though `state` remains `EnterSingleText`. Use
`entryId`, not just the state string, to ensure exactly one answer per prompt.
The C# tests contain the observed “Prompt 1 of 2” HTML shape
([`JackboxGPT3/tests/Engines/Quiplash3Tests.cs:9`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/tests/Engines/Quiplash3Tests.cs#L9-L18)).

### Voting in the normal rounds

The eligible voter's per-player state becomes `MakeSingleChoice`, with fields
such as `choiceId`, `prompt`, `choices`, `chosen`, `doneText`, and sometimes
`choiceType`. Each choice supplies the value to send as an `index` in the public
controller; independent clients have observed a `key` property. Prefer
`choice.index`, then `choice.key`; use the visual array position only as a
last-resort compatibility fallback. Skip `disabled` choices.

```json
{
  "seq": 4,
  "opcode": "client/send",
  "params": {
    "from": 2,
    "to": 1,
    "body": { "action": "choose", "choice": 0 }
  }
}
```

The value `0` is only an example; send the selected option's runtime identifier.
The public controller emits `action: "choose"` and the option `index`, while
the Go implementation extracts `choices[].key` and de-duplicates with
`choiceId` plus entity version/prompt/choice data
([`jackbox-int-tv/main/pp7/quiplash3/script.js:27520`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L27520-L27675),
[`rolando/internal/jackbox/games/quiplash3.go:209`](https://github.com/LJS360d/rolando/blob/17cf2a9c9254b33dcc84745bf9fa269f1e6b495e/internal/jackbox/games/quiplash3.go#L209-L295)).

After acceptance, `chosen` becomes non-null and the choices are hidden. There
is no additional done request. `Logo` and `Gameplay_Logo` are passive/interstitial
states in the older C# model
([`JackboxGPT3/src/Games/Quiplash3/Models/Quiplash3Room.cs:7`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Quiplash3/Models/Quiplash3Room.cs#L7-L16)).

### Final round: Thriplash entry

Thriplash uses `state: "EnterTextList"`. Read `fieldCount` (normally 3),
`maxLength`, `entryId`, `prompt`, `textKey`, `entries`, and `doneText` from the
player entity. Submit all answers as one newline-delimited text value:

```json
{
  "seq": 5,
  "opcode": "text/update",
  "params": {
    "key": "entertext:2",
    "val": "FIRST ANSWER\nSECOND ANSWER\nTHIRD ANSWER"
  }
}
```

Do not send a JSON array to `text/update`; the controller explicitly joins its
input array with `\n`, and the newer Go implementation does the same
([`jackbox-int-tv/main/pp7/quiplash3/script.js:31296`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L31296-L31360),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:31414`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L31414-L31430),
[`rolando/internal/jackbox/games/quiplash3.go:163`](https://github.com/LJS360d/rolando/blob/17cf2a9c9254b33dcc84745bf9fa269f1e6b495e/internal/jackbox/games/quiplash3.go#L163-L177)).

As with a single answer, `entries` becoming non-null/truthy is the done marker;
there is no separate completion frame. The generic no-`textKey` fallback is a
host message with body `{ "action": "write", "entries": ["FIRST", "SECOND",
"THIRD"] }`, but its use in a real Quiplash 3 session is unconfirmed.

### Final voting

Thriplash voting again uses `MakeSingleChoice` and the exact same player vote
frame:

```json
{
  "seq": 6,
  "opcode": "client/send",
  "params": {
    "from": 2,
    "to": 1,
    "body": { "action": "choose", "choice": "RUNTIME_CHOICE_ID" }
  }
}
```

Old JackboxGPT3 code observed two spellings of `choiceType`, `ChoseQuip` for a
normal choice and `ChooseQuip` for Thriplash, and its author explicitly wondered
whether this was a typo
([`JackboxGPT3/src/Games/Quiplash3/Models/Quiplash3Player.cs:30`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Quiplash3/Models/Quiplash3Player.cs#L30-L36)). Do not make protocol correctness depend on those labels; the state and choices
are sufficient.

### Post-game VIP choices

The post-game controls reuse `Lobby` with `playerIsVIP: true`,
`gameCanStart: true`, `playerCanStartGame: true`, and `gameFinished: true`.
The UI labels and action bodies differ:

```json
{
  "seq": 7,
  "opcode": "client/send",
  "params": {
    "from": 2,
    "to": 1,
    "body": { "action": "PostGame_Continue" }
  }
}
```

`PostGame_Continue` is “Same Players.” “New Players” is:

```json
{
  "seq": 8,
  "opcode": "client/send",
  "params": {
    "from": 2,
    "to": 1,
    "body": { "action": "PostGame_NewGame" }
  }
}
```

These exact actions are built by the public lobby controller
([`jackbox-int-tv/main/pp7/quiplash3/script.js:27116`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L27116-L27130),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:27186`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L27186-L27292)). What happens to the existing WebSocket and room code after `PostGame_NewGame`
is host/game behavior and is not established by the player sources.

**Confidence: high** for state names and all normal sends; **medium** for the
full set of incoming fields and no-`textKey` fallbacks; **low** for undocumented
round-number and post-`PostGame_NewGame` behavior.

## 5. Player-visible state versus host/TV state

An ordinary player can directly observe only entities included in its welcome
snapshot or later sent through its ACL. For Quiplash 3, the examined clients
make useful decisions from:

- shared `room` lobby/game data;
- its own `player:{id}` prompt, answer completion, choices, and selected choice;
- accessibility `textDescriptions`, if supplied;
- `room/lock`, `room/exit`, socket state, and acknowledgements.

During a vote, an eligible player receives the prompt and candidate choice HTML,
so it can observe the answer text it is being asked to judge. The C# player
model contains `prompt`, `choices`, `choiceType`, `textKey`, and `entries`, but
its `playerInfo` model contains identity/avatar fields rather than vote totals
or score
([`JackboxGPT3/src/Games/Quiplash3/Models/Quiplash3Player.cs:6`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Quiplash3/Models/Quiplash3Player.cs#L6-L64)).

No examined Quiplash 3 player implementation parses resolved per-answer vote
counts, score deltas, a scoreboard entity, or a `tv` entity. This is evidence
that a minimal player client cannot rely on those values; it is **not proof**
that the service never places a score field in a player-readable object. Model
such fields as optional discoveries until a source fixture or authorized trace
establishes their names.

The host is different. It owns/creates entities and their ACLs, receives player
`text/update` mutations and `client/send` messages, and receives
`client/connected`/`client/disconnected`. A private server demonstrates that
updates are forwarded to the host while only ACL-authorized entity snapshots
are sent to a joining player
([`johnbox/johnbox.js:338`](https://github.com/InvoxiPlayGames/johnbox/blob/69ec98e92226168d8fd11c4dbbe4de21fae6b2e1/johnbox.js#L338-L442),
[`johnbox/johnbox.js:478`](https://github.com/InvoxiPlayGames/johnbox/blob/69ec98e92226168d8fd11c4dbbe4de21fae6b2e1/johnbox.js#L478-L508)). It is therefore reasonable to expect authoritative vote aggregation and full
score presentation to remain host/TV concerns, but the exact Quiplash 3 host
entity keys and schemas are outside the examined player sources.

`bc:` means a compatibility serialization path, not “broadcast to every
client.” Conversely, a key named `tv`, if encountered, would not by itself prove
visibility: ACL determines delivery. Do not guess either key's contents.

**Confidence: high** for what the cited player clients consume; **medium** for
the host/ACL boundary; **low** for exact result, score, and TV-only schemas.

## 6. Audience role

### Connect

When `room.audienceEnabled` is true, connect with `ecast-v0` to:

```text
wss://{body.audienceHost}/api/v2/audience/{CODE}/play
  ?role=audience
  &name={URL_ENCODED_NAME}
  &format=json
  &user-id={STABLE_UUID}
```

Use `body.host` only as an `audienceHost` fallback. The public controller chooses
the `/api/v2/audience/` path for `role=audience` and also for reconnect ids over
10,000,000
([`jackbox-int-tv/main/pp7/quiplash3/script.js:14191`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L14191-L14212)). Its role check tolerates an audience welcome with no role-bearing profile, so
`here`/`profile` may be absent or null for audience clients
([`jackbox-int-tv/main/pp7/quiplash3/script.js:30769`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30769-L30776)). Reconnect uses the same `id`, `secret`, `device-id`, and original
`user-id` scheme as a player, but returns to the audience path.

### Vote

Audience voting does **not** use player `client/send`/`choose`. When the merged
audience state is `MakeSingleChoice`, take the runtime `countGroupName` and the
selected option's runtime identifier and send:

```json
{
  "seq": 1,
  "opcode": "audience/count-group/increment",
  "params": {
    "name": "RUNTIME_COUNT_GROUP_NAME",
    "vote": "RUNTIME_CHOICE_ID",
    "times": 1
  }
}
```

The public choice controller sends a count-group event for audience members,
and its ecast helper emits the exact opcode and parameter names
([`jackbox-int-tv/main/pp7/quiplash3/script.js:27641`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L27641-L27675),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:14640`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L14640-L14663)). `vote` is stringified by the controller. The count-group name is game state,
not a known Quiplash 3 constant; do not invent or hard-code it. If it is absent,
the generic controller derives a name from its session-module prefix and layout
name, but consuming the server-provided name is safer
([`jackbox-int-tv/main/pp7/quiplash3/script.js:30569`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30569-L30599)).

Audience presentation comes from `room.audience` and/or `audiencePlayer`; the
controller merges those rather than a normal `player:{id}` object
([`jackbox-int-tv/main/pp7/quiplash3/script.js:30442`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30442-L30456),
[`jackbox-int-tv/main/pp7/quiplash3/script.js:31665`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L31665-L31688)).

### Audience count visibility

The authoritative generic operation is host-facing:

```json
{ "seq": 20, "opcode": "room/get-audience", "params": {} }
```

with a correlated reply whose `result` is `{ "connections": NUMBER }`. The
public ecast client exposes this method, and private servers implement it by
counting audience connections
([`jackbox-int-tv/main/pp7/quiplash3/script.js:14301`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L14301-L14315),
[`jonahbox/src/ecast/ws.rs:1305`](https://github.com/StratusFearMe21/jonahbox/blob/765605084fc3e85f3c4e0e523b827c46fe053dc9/src/ecast/ws.rs#L1305-L1327)).

The sources do not prove that a normal Quiplash 3 player can read the total.
An audience client may receive aggregate `audience` or count-group entities when
their ACL permits it, but that is not equivalent to a guaranteed total audience
field. The v1 `numAudience` lookup field belongs to the old API and must not be
assumed in the v2 room response.

**Confidence: high** for audience routing and count-group vote JSON; **medium**
for audience welcome variations; **low** for audience-count visibility outside
the host.

## 7. Operational gotchas

### Reconnect and disconnects

- Keep the same UUID for the logical participant, and retain welcome `id`,
  `secret`, and `deviceId`. A fresh UUID can create a second player rather than
  resuming the first.
- Apply the reconnect welcome's entire entity snapshot before resuming the game
  reducer. Do not replay commands merely because the same state was delivered
  again.
- The public controller automatically reconnects only after an established
  socket closes abnormally with code `1006`. It starts with a randomized
  1,000–1,499 ms delay, doubles it, caps at 13 seconds, and exposes five-attempt
  UI semantics. Normal/no-status closure is treated as terminal
  ([`jackbox-int-tv/main/pp7/quiplash3/script.js:14167`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L14167-L14264),
  [`jackbox-int-tv/main/pp7/quiplash3/script.js:30525`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L30525-L30549)).
- JackboxGPT3 explicitly disables WebSocket-library reconnection and exits on a
  drop. That is a limitation of that client, not protocol evidence that resume
  is unsupported
  ([`JackboxGPT3/src/Games/Common/BaseJackboxClient.cs:50`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Common/BaseJackboxClient.cs#L50-L83)).

### Sequencing, acknowledgements, and idempotence

- Increment `seq` exactly once for each request and correlate `ok`/`error` using
  `re`. Put a timeout around pending requests and reject them when the socket is
  terminally closed.
- Preserve the latest server `pc` for diagnostics and possible host replay, but
  do not use it as the next client `seq`.
- Entity `version` is useful for ordering and de-duplication. Handle welcome
  snapshots before deltas, ignore a stale version where appropriate, and remove
  state on `drop`.
- State updates can be repeated. De-duplicate answer generation by `entryId` and
  voting by `choiceId` plus version/choice content. The newer Go client does
  both; the original C# client reacts directly to revisions
  ([`rolando/internal/jackbox/games/quiplash3.go:156`](https://github.com/LJS360d/rolando/blob/17cf2a9c9254b33dcc84745bf9fa269f1e6b495e/internal/jackbox/games/quiplash3.go#L156-L207),
  [`rolando/internal/jackbox/games/quiplash3.go:209`](https://github.com/LJS360d/rolando/blob/17cf2a9c9254b33dcc84745bf9fa269f1e6b495e/internal/jackbox/games/quiplash3.go#L209-L272)).
- Do not assume that a successful `text/update` is echoed to the sender. Treat
  its correlated `ok` as transport acceptance and the later player object's
  `entry`/`entries` marker as game-level completion.

### Keepalive

`keepalive` appears in room lookup data, but the examined official controller
does not emit an application-level JSON heartbeat. Use a WebSocket library that
automatically responds to control-frame pings with pongs. A modern private Rust
server sends WebSocket ping frames every five seconds, which supports this
transport-level interpretation but does not establish the production interval
([`jonahbox/src/ecast/ws.rs:556`](https://github.com/StratusFearMe21/jonahbox/blob/765605084fc3e85f3c4e0e523b827c46fe053dc9/src/ecast/ws.rs#L556-L583)).

Do not copy the `PING = 2` / Socket.IO pong logic from `jackbox-bot`; that repo
implements the older colon-framed Blobcast transport, not ecast v2
([`jackbox-bot/jackbox_client.rb:1`](https://github.com/smoak/jackbox-bot/blob/3bd82f354af75c70a5bec216b0abe37dabc3e688/jackbox_client.rb#L1-L64)).

### Timing and rate limits

No examined source documents an official request-per-second limit. The 2023
JavaScript bot waits at least 250 ms after its last `ok` before voting or
generating another Thriplash response and delays answer submission by one
second (plus four seconds for Thriplash)
([`JackboxGPT/gamemodes/quiplash3.js:27`](https://github.com/Electric131/JackboxGPT/blob/73d8e716034b38d6151a6aae54ac503d9e1da56f/gamemodes/quiplash3.js#L27-L48),
[`JackboxGPT/gamemodes/quiplash3.js:79`](https://github.com/Electric131/JackboxGPT/blob/73d8e716034b38d6151a6aae54ac503d9e1da56f/gamemodes/quiplash3.js#L79-L106)). Those are bot workarounds for repeated state and asynchronous generation, not
proof of a server rate limit. A sensible client should serialize per-player
actions, await `ok`/`error`, and avoid rapid retries, but should not encode 250
ms as a protocol constant.

### Prior-art implementation traps

- Prefer the runtime `textKey`. Older JackboxGPT hard-codes
  `entertext:{clientData.id}`
  ([`JackboxGPT/gamemodes/template.js:7`](https://github.com/Electric131/JackboxGPT/blob/73d8e716034b38d6151a6aae54ac503d9e1da56f/gamemodes/template.js#L7-L23)).
- JackboxGPT3's `TextUpdateRequest.Key` is declared `static`, so concurrent
  instances can overwrite one another's key. Do not reproduce that model
  ([`JackboxGPT3/src/Games/Common/Models/TextUpdateRequest.cs:5`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Common/Models/TextUpdateRequest.cs#L5-L21)).
- JackboxGPT3 handles only `text` and `object` notifications and does not
  correlate `ok`/`error`; use it for Quiplash payload evidence, not as a complete
  generic ecast implementation
  ([`JackboxGPT3/src/Games/Common/BaseJackboxClient.cs:85`](https://github.com/tjhorner/JackboxGPT3/blob/ba8ade3272fbeb4f9f50518be8a3f364362889e3/src/Games/Common/BaseJackboxClient.cs#L85-L127)).
- Use the selected choice's runtime identifier, not an assumed array offset.
- Send Thriplash answers as exactly `fieldCount` lines and preserve intentional
  line boundaries. Enforce the state-provided maximum on each generated answer.
- HTML-decode and strip markup from prompts/choices for model input, but send
  plain answer text. The client controller performs Unicode filtering and HTML
  escaping; a non-browser client should apply equivalent length and safety
  validation
  ([`jackbox-int-tv/main/pp7/quiplash3/script.js:31145`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L31145-L31151),
  [`jackbox-int-tv/main/pp7/quiplash3/script.js:31469`](https://github.com/jackbox-int/tv/blob/8bcbf046d678b452680fc9d9df23f681e76212e1/main/pp7/quiplash3/script.js#L31469-L31478)).

**Confidence: high** for sequence correlation, reconnect behavior of the public
controller, idempotence keys, and prior-art bugs; **medium** for keepalive
interpretation; **low/unknown** for production rate limits.

## Recommended TypeScript client design

Keep transport, entity replication, and Quiplash behavior separate:

```text
RoomDirectoryClient
  -> EcastConnection
       -> EntityStore
            -> Quiplash3Projection
                 -> Quiplash3Player / Quiplash3Audience
```

### Components

`RoomDirectoryClient` should normalize the code, fetch/decode the `{ok, body}`
envelope, retain unknown lookup fields, and return typed `host` and
`audienceHost` values.

`EcastConnection` should own the WebSocket, stable UUID, request sequence,
`Map<seq, PendingRequest>`, `pc`, welcome credentials, reconnect policy, and
opcode decoder. Its API can expose `request(opcode, params): Promise<Result>`
and events such as `welcome`, `entity`, `drop`, `lock`, `roomExit`, and
`connectionState`. Use discriminated unions for known opcodes but preserve an
`UnknownNotification` branch so new game fields do not crash the socket.

`EntityStore` should atomically replace itself from the welcome `entities`
snapshot, then apply `object`/`text`/`number`, `lock`, and `drop` notifications.
Store `{type, key, value, version, from, locked}` and emit keyed changes only
after accepting the version. Keep ACL metadata opaque on the player side.

`Quiplash3Projection` should merge `room` with `player:{welcome.id}`, or the
audience variants, and reduce the result to a narrow union such as:

```ts
type Quiplash3View =
  | { state: "Lobby"; /* VIP and character fields */ }
  | { state: "EnterSingleText"; entryId?: string; textKey?: string; /* ... */ }
  | { state: "EnterTextList"; entryId?: string; textKey?: string; /* ... */ }
  | { state: "MakeSingleChoice"; choiceId?: string; /* ... */ }
  | { state: "Passive"; rawState?: string };
```

Validate only the fields needed for the current action. Keep the raw object
alongside the projection because the protocol is schemaless and additive.

`Quiplash3Player` should expose intent-level commands—`chooseAvatar`,
`startGame`, `submitAnswer`, `submitThriplash`, `vote`, `samePlayers`, and
`newPlayers`—rather than raw opcodes. It should refuse commands that do not
match current state/capabilities, obtain `textKey` and choice identifiers from
the current projection, await the request acknowledgement, and record handled
`entryId`/`choiceId` tokens. Clear or reconcile those tokens after a reconnect
snapshot rather than blindly replaying a command.

`Quiplash3Audience` should use the audience host/path and expose only the
count-group vote command. It should require a runtime `countGroupName` and
stringify the selected vote id.

### Event flow

1. Look up the room and verify the supported `appTag`.
2. Construct the role-specific URL from the returned host and connect with
   `ecast-v0`.
3. On `client/welcome`, store credentials, replace the entity store from the
   snapshot, discover the host id, and only then emit `ready`.
4. Apply entity notifications in arrival/version order and re-project state.
5. Emit an intent event once per new `entryId` or `choiceId`; let the caller
   produce an answer/vote.
6. Validate and send the exact command, correlate `re`, and wait for the
   player-state done marker.
7. On abnormal close, reconnect with the original identity and secret using
   bounded exponential backoff; on normal close or `room/exit`, reject pending
   requests and finish.

Keep credentials and raw frames out of normal logs. A redacted diagnostic mode
should log `seq`, `pc`, `re`, opcode, entity key/version, state, `entryId`, and
`choiceId`; those fields are enough to debug ordering without leaking answers
or reconnect secrets.

**Confidence: high** that this decomposition matches the observed event flow;
**medium** that it is the best fit for QuipArena until the existing package
boundaries and test harness are mapped to these roles.
