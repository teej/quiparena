# Quiplash 3 controller protocol from jackbox.tv

Retrieved 2026-09-02 (America/Los_Angeles). This is a static-code reference for
the Party Pack 7 app tag `quiplash3`. No room WebSocket was opened and no live
room was contacted.

The strongest conclusion is also an important limitation: the browser merges
the shared `room` object and the private player object before rendering. The
JavaScript therefore proves which merged fields the controller consumes and
what it sends, but it does not prove which object originally supplied every
field, nor does it expose TV-only result models.

## Source corpus

The files below were downloaded from jackbox.tv's current production asset
graph and pretty-printed without semantic changes. Later citations use the
short name in the first column.

| Citation name | Downloaded file                                                                                                                                           | Purpose                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `loader`      | [`CBNPv9r1.pretty.js`](/private/tmp/claude-501/-Users-teej-Code-quiparena/5101469a-c685-4910-b7fe-7b570b36f4e8/scratchpad/jackboxtv/CBNPv9r1.pretty.js:1) | Script-tag bundle, loader, and production manifest                                               |
| `connect`     | [`B4-mCodY.pretty.js`](/private/tmp/claude-501/-Users-teej-Code-quiparena/5101469a-c685-4910-b7fe-7b570b36f4e8/scratchpad/jackboxtv/B4-mCodY.pretty.js:1) | Lazy `@connect` bundle: room lookup, name handling, host selection, and persisted reconnect data |
| `controller`  | [`db0w6vxc.pretty.js`](/private/tmp/claude-501/-Users-teej-Code-quiparena/5101469a-c685-4910-b7fe-7b570b36f4e8/scratchpad/jackboxtv/db0w6vxc.pretty.js:1) | Lazy `quiplash3` controller and the ecast client it actually registers                           |

The root HTML loaded `/CBNPv9r1.js`. Its production manifest maps `@connect`
to `https://bundles.jackbox.tv/main/@connect/B4-mCodY.js` and `quiplash3` to
`https://bundles.jackbox.tv/main/pp7-quiplash3/db0w6vxc.js`, version
`5.824.421`; the loader constructs those S3 URLs and injects module scripts
(`loader:21244-21281`, `loader:21737-21748`, `loader:21974-21980`). Both lazy
files are self-contained bundles; neither imports another JavaScript chunk.
The advertised source maps were not publicly readable (the Quiplash map
returned HTTP 403).

Original-file SHA-256 values:

- `CBNPv9r1.js`: `114b79832956ac6e7ad3d1df35c45716d17ece17b120ffc7330a83b69fd5fea3`
- `B4-mCodY.js`: `b9b6ced2ca916accd82435b5a61ae3da5be782a41f0e451a3001ffaa7a783ff2`
- `db0w6vxc.js`: `4f33b6865300cf9db31d8c062d20ecdc4e3c75788577f0e6edf75f9e7a2e2bd7`

## A. Connection

### Room lookup and controller selection

For the production site, the directory host is
`ecast.jackboxgames.com`. The connect bundle creates an HTTPS API client and
requests:

```http
GET https://ecast.jackboxgames.com/api/v2/rooms/{CODE}
```

It decodes the `{ ok, body }` envelope and retains `appId`, `appTag`,
`audienceEnabled`, `code`, `host`, `audienceHost`, `locked`, `full`, player
limits, moderation/password/Twitch flags, `locale`, `keepalive`, and
`controllerBranch` (`connect:16828-16842`, `connect:26641-26717`). The app tag
selects the `quiplash3` manifest entry above.

The connect screen uses `room.host` for a player and
`room.audienceHost` for audience. The current code has **no fallback** from a
missing `audienceHost` to `host`; it simply will not enter the connection path
without a truthy selected host (`connect:46959-47025`).

### Player and audience URLs

The Quiplash bundle's registered ecast client constructs these URLs and opens
them with the single WebSocket subprotocol `ecast-v0`
(`controller:21333-21451`):

```text
wss://{room.host}/api/v2/rooms/{CODE}/play
  ?role=player
  &name={URL_ENCODED_NAME}
  &format=json
  &user-id={STABLE_UUID}
  [&password={PASSWORD}]
  [&twitch-token={TOKEN}]
```

```text
wss://{room.audienceHost}/api/v2/audience/{CODE}/play
  ?role=audience
  &name={URL_ENCODED_NAME}
  &format=json
  &user-id={STABLE_UUID}
```

The query builder also includes `id` when reconnecting, `device-id` when the
client has one, and `secret` when known. Host-only options are `host-token`,
`replay-since`, and `sync-entities`. The audience path is selected when
`role === "audience"` or the reconnect id is greater than 10,000,000
(`controller:21385-21415`). Undefined values are omitted by the query-string
serializer.

The connect screen sanitizes the name, trims it, uppercases interactive input,
and stores one UUID under `uuid`; it passes that UUID as `userId` on every join
(`connect:46688-46701`, `connect:46959-46982`).

### Welcome and entity snapshot

`client/welcome.result` is decoded with these fields:

```json
{
  "id": 2,
  "deviceId": "SERVER_DEVICE_ID",
  "name": "PLAYER",
  "secret": "SERVER_SECRET",
  "reconnect": false,
  "entities": {},
  "here": {},
  "profile": {},
  "replayEnd": 0
}
```

Each `entities` member is decoded from the tuple
`[opcode, result, metadata]`. A welcome replaces the client's entity map,
stores `id`, `deviceId`, `secret`, and any server-normalized name, then resolves
the initial connection (`controller:20661-20691`,
`controller:21141-21315`, `controller:21415-21437`).

The Quiplash adapter finds the room owner as the member of `here` whose
`roles.host` is truthy. All `client/send` calls go to that member's id, falling
back to `1` if no host was found (`controller:40593-40614`,
`controller:40722-40734`).

### Reconnect

There are two distinct reconnect cases.

1. **Same page, abnormal close.** After a welcome, close code `1006` invokes
   reconnect. The existing client retains `id`, `secret`, `deviceId`, role,
   name, and UUID, so all three credentials (`id`, `secret`, `device-id`) are
   included. Any other close code is terminal to this automatic path
   (`controller:21438-21450`). The first reconnect attempt is immediate. After
   failures it waits a random 1,000–1,499 ms, doubles that delay, caps it at
   13,000 ms, and stops on a failed attempt made with the 13,000 ms value;
   normal/no-status errors 1000/1005 are terminal (`controller:21329-21332`,
   `controller:21463-21488`).
2. **Page reload.** The connect screen persists exactly
   `id:role:secret:branch`, plus the name, room code, and stable UUID. It does
   **not** persist `deviceId`. Consequently a reload reconnect passes `id`,
   `secret`, and the original `user-id`, but not `device-id`
   (`connect:46663-46681`, `connect:46959-46982`,
   `connect:47029-47036`).

The welcome's `reconnect` boolean is reported to analytics but does not change
the state reducer (`connect:46989-47020`). Secrets are bearer credentials and
must not be logged.

### Frames, `seq`, `re`, and keepalive

A request is serialized from an object with `seq`, `opcode`, and `params`:

```json
{
  "seq": 1,
  "opcode": "text/update",
  "params": { "key": "entertext:2", "val": "answer" }
}
```

The client initializes `seq` to zero and pre-increments it once per send. It
stores a promise under that sequence. A server message with truthy `re` is a
reply; `re` indexes and removes the pending promise. An ecast error result
rejects it and any other result resolves it. Messages without `re` are
notifications and carry `pc` (`controller:20893-20907`,
`controller:21306-21315`, `controller:21506-21532`). Thus `pc` is not a client
sequence and `re` is the request/reply correlation key.

There is no request timeout, pending-request rejection on disconnect, or
application heartbeat in this Quiplash client. `keepalive` is only copied from
the room-directory response (`controller:19930-19950`,
`controller:20001-20025`); the WebSocket lifecycle contains no keepalive send
or interval (`controller:21333-21532`). Therefore the exact JavaScript
keepalive interval is: **none**. Browser handling of WebSocket ping/pong control
frames is below this JavaScript and no production server ping interval can be
deduced here.

## B. Controller entity projection and state table

### Recognized entity keys and merge order

Snapshots and later updates recognize:

- `room`, `roomBlob`, and `bc:room` as the shared room value;
- `player`, `player:{welcome.id}`, and `bc:customer:{userId}` as the player
  value;
- `audiencePlayer` as an audience wrapper;
- `textDescriptions` as a special object update.

Both JSON-in-`text` and native `object` forms are supported
(`controller:40616-40633`, `controller:40666-40708`). `bc:` is merely a
compatibility alias in this code; it does not mean that the entity is broadcast
to every connection.

For a player, the render blob is:

```js
{ ...omit(room, "audience"), ...player }
```

For audience it is the same room base plus `audiencePlayer.audience`, falling
back to `room.audience`. The adapter then injects `isPlayer` and `isAudience`
(`controller:40229-40248`). Player fields win on collisions. This is why the
static source cannot reliably assign every listed field to `room` versus
`player:{id}`.

### State values

The exact set of state strings routable by the Quiplash `MainView` is:

```text
Lobby | Logo | EnterSingleText | EnterTextList | MakeSingleChoice | UGC |
Draw | Shoot | Sortable | Camera
```

The first six have direct Quiplash-specific evidence and are the meaningful
Quiplash state machine exposed by this asset:

| State              | Fields actually consumed by its UI                                                                                                                                                                                                                                                                                                                                                    | Completion/action semantics                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Lobby`            | `characters`; `playerInfo`; `classes`; `playerIsVIP`; `gameCanStart`; `playerCanStartGame`; `gameIsStarting`; **`gameFinished`**; `playerCanCensor`; `censorablePlayers`; `choices`; `canChangeName`; `artifact`; `playerCanDoEpisodes`; `activeContentId`; `formattedActiveContentId`; `history`; `lastUGCResult`; `playerCanReport`; `playerCanViewAuthor`; `lobbyState`; `strings` | Character selection, VIP start/cancel/post-game, name change, censor, and episode controls. `gameIsStarting` is the only countdown-like field, and it is Boolean. |
| `Logo`             | `message.{text,html}`, `classes`, `action`, `artifact.{rootId,categoryId,artifactId}`; Quiplash also uses `playerInfo.avatar` to style it                                                                                                                                                                                                                                             | Passive/interstitial. The layout has no ecast-action handler.                                                                                                     |
| `EnterSingleText`  | `prompt`; `textKey`; `entryId`; `entry`; `doneText`; `maxLength`; `allowEmpty`; `autoSubmit`; `live`; `repeating`; `actions`; `suggestions`; `error`; `strings`; `placeholder`; `autocapitalize`; `className`; `inlineSubmit`; `inlineSubmitText`; `block`; `classes`; `playerInfo`                                                                                                   | The form is visible iff `entry` is falsy. `entryId` clears the input when it changes; it is not sent.                                                             |
| `EnterTextList`    | `prompt`; `textKey`; `fieldCount`; `entries`; `doneText`; `maxLength`; `autoSubmit`; `actions`; `error`; `strings`; `placeholder`; `autocapitalize`; `className`; `block`; `classes`; `playerInfo`                                                                                                                                                                                    | The form is visible iff `entries` is falsy. All fields use the same per-answer `maxLength`.                                                                       |
| `MakeSingleChoice` | `prompt`; `choices`; `choiceId`; `type`; `chosen`; `doneText`; `error`; `block`; `classes`; `maxVotes`; `countGroupName`; `censorDialog`; `strings`; `playerInfo`; `toggle`                                                                                                                                                                                                           | Choices remain visible while `chosen` is `null` or `""`. `choiceId` resets local audience selection; it is not sent in a vote.                                    |
| `UGC`              | `validActions`; `text`; `noActionsText`; `episodes`; `prompts`; `episodeTitle`; `maxContentLength`; `maxTitleLength`; `controllerVisibility`; `screenVisibility`; `count`; `maxCount`; localized `strings`; Quiplash `toggle`                                                                                                                                                         | Custom-episode authoring and management, not ordinary round gameplay.                                                                                             |

The Quiplash state dispatch is at `controller:41718-41732`; `Logo` and
`MakeSingleChoice` fall through to the shared layouts at
`controller:40187-40211`. The detailed models/renderers are at:

- lobby: `controller:35530-36066`;
- logo: `controller:36077-36149`;
- single text: `controller:35087-35307`, with Quiplash overrides at
  `controller:41197-41284`;
- text list: `controller:41355-41508`;
- choice: `controller:36302-36596`;
- UGC: `controller:39002-39458`, with Quiplash additions at
  `controller:41671-41716`.

The inherited common switch can also render `Draw`, `Shoot`, `Sortable`, and
`Camera`. Nothing in the Quiplash-specific code ties those four layouts to an
actual Quiplash 3 server state; they are shared controller capabilities, not
evidence that the Quiplash host emits them. Conversely, `Gameplay_Logo` does
not occur in the current controller and would reach “No common layout found.”

### Common value shapes

`prompt` is not HTML-only. The prompt component accepts
`{ text, html, className, background }`, preferring `html` over escaped `text`
(`controller:30379-30406`).

Each `choices[]` item can supply:

```json
{
  "key": 0,
  "text": "plain label",
  "html": "<div>rich label</div>",
  "label": "ARIA label",
  "action": "choose",
  "disabled": false,
  "visible": true,
  "className": "optional classes",
  "color": { "text": "#fff", "background": "#000" },
  "censorable": false
}
```

For controller purposes, the choice identifier is **`choice.key` when present,
otherwise the zero-based array position**. Incoming `choice.index` is not read.
The view derives an internal property named `index` from key-or-position and
sends that (`controller:11679-11818`, `controller:30408-30437`,
`controller:36454-36510`). Quiplash rewrites `<div>` elements inside choice
HTML for Thriplash accessibility but does not change identifiers
(`controller:41770-41786`).

`doneText`, `chosen`, and prompt/message values are rendered as objects with
`html` or `text`. Despite some empty-string defaults, a truthy bare string is
not a useful `doneText` shape in these renderers (`controller:35138-35149`,
`controller:36331-36368`, `controller:41403-41426`).

The player header and state styling consume these `playerInfo` members when
present: `username`, `avatar`, `bgColor`, `buttonColor`, `textColor`,
`topBarColor`, `classes`, and `hidden` (`controller:35648-35704`,
`controller:36271-36301`, `controller:41770-41795`).

There is no numeric `timer`, `countdown`, `timeLeft`, or deadline field read by
any Quiplash-specific layout. The lobby model has a nested `game.extendedTimers`
default and `game.skipTutorials` default, but the layout never consults either;
it only branches on `gameIsStarting` (`controller:35530-35546`,
`controller:35735-35783`). Round deadlines are therefore TV/host-side-only as
far as this static controller is concerned.

### Character, name, and answer constraints

- A character is selectable only when `available` is truthy and it is not
  already selected. Selection is determined by
  `playerInfo.avatar === character.name`. The only required incoming character
  fields are `name` and `available` (`controller:35584-35633`,
  `controller:35829-35842`, `controller:36053-36066`).
- Join names have an exact UI maximum of 12 characters. The join screen strips
  leading whitespace, removes characters outside its username allowlist,
  converts ASCII apostrophe to U+2019, uppercases interactive input, and trims
  before connection. A long Twitch-derived name becomes 11 code units plus an
  ellipsis (`connect:33359-33401`, `connect:46471-46509`,
  `connect:46688-46701`, `connect:46778-46791`,
  `connect:46959-46966`). Lobby “Change Name” also enforces 12 characters, but
  sends the entered value directly (`controller:35858-35887`).
- Quiplash answer length is state-driven by `maxLength`; **45 is not a protocol
  constant in this bundle**. The Quiplash model fallback is 500. Input filtering
  splits Unicode grapheme clusters, removes emoji introduced after Unicode 13,
  and truncates to `maxLength` (`controller:30186-30201`,
  `controller:41197-41217`). The visible template's initial `0/45` and UGC's
  default `maxContentLength: 45` do not establish the runtime answer limit.
- Thriplash count is state-driven by `fieldCount`; the controller does not
  default it to three. The host must supply it (`controller:41438-41466`).

### Errors, filtering, descriptions, and censoring

Single-text and list layouts render an `error` supplied as a string or as
`{text}`/`{html}`. Empty submission is a local error. A rejected
`text/update` may arrive as ecast filter error 2021; the adapter calls the
layout's `onTextFilterError` when it has one (`controller:20350-20632`,
`controller:35250-35291`, `controller:40353-40377`,
`controller:41480-41492`). The current Quiplash bundle contains no dedicated
`duplicateAnswer`, `duplicate-answer`, or similarly named field or message.
Any duplicate-answer rejection visible to this UI must therefore be carried by
the generic `error`/`strings` path or by an ecast error reply; its exact host
wording is not statically present.

There are two censor flows:

- Lobby VIP censorship uses `playerCanCensor` and
  `censorablePlayers[{id,name}]`, then sends a player id
  (`controller:35773-35779`, `controller:35888-35924`,
  `controller:36023-36028`).
- Choice censorship uses `choice.censorable`, `censorDialog` (`none`,
  `confirm`, or `warning`), and sends the derived choice key/position
  (`controller:11784-11808`, `controller:36527-36570`).

The exact `textDescriptions` entity is an object whose value contains
`latestDescriptions: [{ id?, text }]`. The controller de-duplicates by id among
the last ten descriptions and appends `text` to an ARIA live log. A merged
state may alternatively contain a `textDescriptions` array directly
(`controller:40224-40228`, `controller:40259-40273`,
`controller:40693-40701`). Quiplash also replaces the first literal `\\n` in
each description with `", "` (`controller:41796-41804`). The source does not
establish which descriptions are ACL-visible to a player.

## C. Send table

### Envelope and routing

Every row marked `client/send` below is inserted verbatim as `body` in this
frame:

```json
{
  "seq": 1,
  "opcode": "client/send",
  "params": {
    "from": 2,
    "to": 1,
    "body": { "action": "start" }
  }
}
```

`from` is the welcome id. `to` is the host id discovered from `here`, with
fallback `1`. The low-level construction is
`mail(to, body) -> send("client/send", {from: this.id, to, body})`
(`controller:21520-21544`, `controller:40722-40734`).

### Core gameplay sends

| State/action                  | Opcode        | Exact `body` or `params` JSON                             | Source                                             |
| ----------------------------- | ------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Select character              | `client/send` | `{"action":"avatar","name":"CHARACTER_NAME"}`             | `controller:36053-36059`                           |
| VIP “Everybody's In”          | `client/send` | `{"action":"start"}`                                      | `controller:35764-35772`, `controller:35858-36021` |
| Cancel game-start countdown   | `client/send` | `{"action":"cancel"}`                                     | `controller:35740-35750`, `controller:35858-36021` |
| Same Players                  | `client/send` | `{"action":"PostGame_Continue"}`                          | `controller:35751-35759`                           |
| New Players                   | `client/send` | `{"action":"PostGame_NewGame"}`                           | `controller:35759-35764`                           |
| Change name                   | `client/send` | `{"name":"NEW NAME"}`                                     | `controller:35858-35887`                           |
| Normal answer, with `textKey` | `text/update` | `{"key":"TEXT_KEY","val":"ANSWER"}`                       | `controller:41218-41244`, `controller:40353-40361` |
| Normal answer, no `textKey`   | `client/send` | `{"action":"write","entry":"ANSWER"}`                     | `controller:41238-41244`, `controller:40399-40405` |
| Live answer, with `textKey`   | `text/update` | `{"key":"TEXT_KEY","val":"PARTIAL ANSWER"}`               | `controller:35236-35247`, `controller:40353-40361` |
| Live answer, no `textKey`     | `client/send` | `{"action":"write-live","entry":"PARTIAL ANSWER"}`        | `controller:35236-35247`, `controller:40399-40405` |
| Safety quip, with `textKey`   | `text/update` | `{"key":"TEXT_KEY","val":"⁇"}`                            | `controller:41274-41283`, `controller:40353-40361` |
| Safety quip, no `textKey`     | `client/send` | `{"action":"safetyQuip"}`                                 | `controller:41274-41283`                           |
| Thriplash, with `textKey`     | `text/update` | `{"key":"TEXT_KEY","val":"FIRST\nSECOND\nTHIRD"}`         | `controller:41482-41503`                           |
| Thriplash, no `textKey`       | `client/send` | `{"action":"write","entries":["FIRST","SECOND","THIRD"]}` | `controller:41482-41503`                           |
| Standard vote                 | `client/send` | `{"action":"choose","choice":0}`                          | `controller:36454-36510`                           |
| Multiple-choice submit        | `client/send` | `{"action":"submit","choice":"0,2"}`                      | `controller:36573-36595`                           |
| Censor a choice               | `client/send` | `{"action":"censor","choice":0}`                          | `controller:36527-36570`                           |
| Censor a player               | `client/send` | `{"action":"censor","id":7}`                              | `controller:36023-36028`                           |
| Generic single-text help      | `client/send` | `{"action":"help"}`                                       | `controller:35298-35306`                           |

The standard vote's `choice` is the selected choice's `key`, or its array
position when `key` is absent. It is not `choiceId`, and an incoming `index`
field is not used. The controller supports numeric or string keys, so preserve
the runtime JSON type.

With `textKey`, the intermediate local object also contains `action` and
`entry`/`entries`, but the adapter deliberately sends only
`text/update {key,val}`. `text/update` has no `from` or `to`. The actual ecast
helper is at `controller:21660-21672`.

For the empty-answer edge case, `EnterSingleText` blocks manual submission
unless `allowEmpty` is true. When an empty value is allowed, the keyed path
sends `val: ""`; the no-key fallback sends `entry: " "`. Manual Thriplash
submission is blocked only when every field is empty; auto-submit can still
send the newline join/array (`controller:41218-41244`,
`controller:41482-41503`).

### Lobby episode and UGC sends

These are part of the Quiplash controller even though QuipArena does not need
them for ordinary games:

| Action                | Exact `client/send` body                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unload active episode | `{"clearContentId":true}`                                                                                                                                                                           |
| View episode author   | `{"viewAuthor":true}`                                                                                                                                                                               |
| Activate episode      | `{"activateContentId":true,"contentId":"ABCDEFG"}`                                                                                                                                                  |
| New local episode     | `{"action":"new"}`                                                                                                                                                                                  |
| Set episode title     | `{"action":"title","text":"TITLE"}`                                                                                                                                                                 |
| Add normal prompt     | `{"action":"add","text":"PROMPT"}`                                                                                                                                                                  |
| Add Thriplash prompt  | `{"action":"add","text":"PROMPT","type":"thriplash"}`                                                                                                                                               |
| Load episode          | `{"action":"load","contentId":"CONTENT_ID"}`                                                                                                                                                        |
| Remove prompt by key  | `{"action":"remove","key":"PROMPT_KEY"}`                                                                                                                                                            |
| Remove prompt by text | `{"action":"remove","text":"PROMPT"}`                                                                                                                                                               |
| Controller visibility | `{"action":"toggle-visibility","target":"controller"}`                                                                                                                                              |
| TV visibility         | `{"action":"toggle-visibility","target":"screen"}`                                                                                                                                                  |
| UGC buttons           | One of `{"action":"close"}`, `{"action":"unlock"}`, `{"action":"done"}`, `{"action":"submit"}`, `{"action":"play"}`, `{"action":"remove-content"}`, `{"action":"exit"}`, or `{"action":"episodes"}` |

Lobby episode sends are at `controller:35926-36050`. The UGC actions and their
confirmation gates are at `controller:39335-39458`, with Quiplash's Thriplash
toggle at `controller:41671-41716`. “Report Episode” opens a support URL and
does not send ecast data (`controller:35928-35934`).

### Data-driven actions and skip tutorial

Lobby `choices[]` buttons send `{"action": choice.action}`. A single-text
action can also send `{"action": action.key}` when the supplied button is
routed through the `choose` handler (the `safetyQuip` branch is the concrete
example). These are data-driven escape hatches (`controller:35823-35828`,
`controller:35858-36021`, `controller:41259-41283`). A custom `action` on a
`MakeSingleChoice` option is not a generic send mechanism: it changes the
Marionette event name and needs a matching handler.

The current static Quiplash bundle contains **no literal skip-tutorial action
name and no dedicated skip handler**. `game.skipTutorials` exists only as an
unused model default. Therefore a statement such as
`{"action":"skipTutorial"}` or `{"action":"skip"}` would be speculation. If
the host supplies such a button dynamically, the resulting body is exactly
`{"action":"ACTION_FROM_STATE"}`, but the action string itself is only
observable from host-authored state or an authorized live trace.

### `object/update`

The shared adapter can translate a child message containing `objectKey` into:

```json
{
  "seq": 9,
  "opcode": "object/update",
  "params": { "key": "OBJECT_KEY", "val": {} }
}
```

(`controller:40378-40398`, `controller:21628-21641`). None of the six
Quiplash-specific states above uses `objectKey`; it belongs to shared layouts
such as drawing. Do not add an `object/update` to the Quiplash harness.

## D. Results visibility

The current player controller has no field reader for resolved vote totals,
per-answer vote counts, score deltas, total scores, rank, or winner. Its
post-choice surface can show only:

- the vote `prompt` and candidate `choices` before voting;
- host-supplied `chosen`, `doneText`, and `error` after voting;
- a generic `Logo.message`/`Logo.action` interstitial;
- a post-game gallery `artifact` in `Logo` or `Lobby`;
- opaque accessibility text delivered through `textDescriptions`.

Those are the complete result-adjacent fields referenced by the choice, logo,
lobby, and description renderers (`controller:36077-36149`,
`controller:36302-36596`, `controller:40224-40273`). `playerInfo` is consumed
only for username/avatar and styling (`controller:36271-36301`,
`controller:41742-41794`).

This does not prove that an ACL-visible entity can never contain unused extra
properties; the reducer is schemaless and would ignore them. It does prove that
a player harness cannot rely on a **structured** score or final-vote contract
implemented by this controller. Opaque `textDescriptions` or `Logo.message`
could narrate results, but their content is not specified. The authoritative
vote breakdown, scoreboard, winner, and any TV-only entity schema require the
host/TV bundle or an authorized trace.

## E. Audience

### Entity and state shape

Audience presentation is taken from either:

```json
{
  "audiencePlayer": {
    "audience": {
      "state": "MakeSingleChoice",
      "prompt": { "html": "..." },
      "choiceId": "RUNTIME_ID",
      "countGroupName": "RUNTIME_GROUP",
      "choices": [
        { "key": 0, "html": "FIRST" },
        { "key": 1, "html": "SECOND" }
      ],
      "chosen": null,
      "doneText": { "text": "Thanks" }
    }
  }
}
```

or the same inner object at `room.audience`. Shared room fields are merged in
first. If the result has no state, the adapter supplies `Logo`; it also replaces
`playerInfo` with `{username:"AUDIENCE", classes:["Audience"]}`
(`controller:40229-40248`, `controller:41752-41765`,
`controller:41787-41795`).

For audience choice UI, the relevant fields are `state`, `prompt`, `choices`,
`choiceId`, `countGroupName`, `type`, `maxVotes`, `toggle`, `chosen`,
`doneText`, and `strings.your_choice`. `type: "single"` is the normal path;
`multiple` submits a comma-joined vote and `repeating` permits repeated votes,
with a default `maxVotes` of 16 and a 101 ms UI throttle
(`controller:36302-36525`, `controller:36573-36595`).

### Vote send

Audience voting never uses player `client/send`. The exact request is:

```json
{
  "seq": 1,
  "opcode": "audience/count-group/increment",
  "params": {
    "name": "RUNTIME_GROUP",
    "vote": "0",
    "times": 1
  }
}
```

The choice controller supplies `countGroupName` and the same key-or-array-index
identifier used by player voting. The adapter stringifies `vote`, and the ecast
helper defaults `times` to 1 (`controller:36496-36510`,
`controller:40418-40427`, `controller:40757-40763`,
`controller:21772-21786`). Preserve the runtime group name; it is not a known
constant.

The shared ecast client has `room/get-audience` and count-group get/create
methods, but the Quiplash audience UI does not call them
(`controller:21536-21544`, `controller:21765-21789`). Static player code does
not establish audience-count visibility or the host's aggregation/result
schema.

## F. Corrections to `docs/ecast-protocol.md` §4

This table is intentionally explicit. “Confirmed” rows are included where the
prior-art section was correct but depended on a mirror or independent client.

| §4 statement or implication                                                                                                    | Current official controller finding                                                                                                                                                         | Disposition                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The effective player state comes from `player:{id}`.                                                                           | The UI merges `room` and player, with player taking precedence. Static code cannot assign every field to one entity.                                                                        | **Correct the entity-origin claim.**                                                   |
| The state list includes passive `Gameplay_Logo`.                                                                               | Current code recognizes `Logo`, not `Gameplay_Logo`; Quiplash also directly recognizes `UGC`.                                                                                               | **Remove `Gameplay_Logo`; add `UGC`.**                                                 |
| A choice's preferred runtime id is `choice.index`, then `choice.key`, then array position.                                     | Incoming `index` is ignored. The derived send id is exactly `choice.key` when present, otherwise array position.                                                                            | **Reverse/correct identifier handling.**                                               |
| `choiceType` (`ChoseQuip`/`ChooseQuip`) may distinguish normal and Thriplash votes.                                            | Current code never reads `choiceType`. The generic choice behavior field is `type` (`single`, `multiple`, `repeating`). Normal and Thriplash both use the same single-choice send.          | **Delete the `choiceType` dependency and typo discussion from the protocol contract.** |
| `entry` becoming non-null and/or `doneText` marks a normal answer done.                                                        | Form visibility depends only on JavaScript truthiness of `entry`; `doneText` alone does not complete the form.                                                                              | **Use truthy `entry`, not non-null or `doneText`.**                                    |
| `entries` becoming non-null/truthy marks Thriplash done.                                                                       | It is specifically truthiness of `entries`.                                                                                                                                                 | **Confirmed, sharpened.**                                                              |
| `chosen` becoming non-null marks voting done.                                                                                  | Choices remain visible for both `null` and `""`; any other value shows the done view.                                                                                                       | **Use `chosen !== null && chosen !== ""`.**                                            |
| `doneText` is shown as a string field.                                                                                         | The renderer expects `{text}` or `{html}`. Empty string is a default, but a truthy bare string has no useful rendering path.                                                                | **Correct the value shape.**                                                           |
| Prompts/choices are HTML.                                                                                                      | Each display value can be `{html}` or `{text}`; prompts also accept `className` and `background`.                                                                                           | **Broaden the value shape.**                                                           |
| Quiplash's answer limit is typically 45, while clients should honor `maxLength`.                                               | The static controller provides no runtime evidence for 45. Its answer fallback is 500; 45 appears in initial markup and UGC prompt defaults.                                                | **Do not document 45 as an observed answer limit. Keep `maxLength` authoritative.**    |
| Thriplash normally has three fields.                                                                                           | `fieldCount` has no Quiplash default and is required from state.                                                                                                                            | **Do not hard-code three.**                                                            |
| `entryId`/`choiceId` are official de-duplication tokens.                                                                       | The official UI uses `entryId` to clear input and `choiceId` to reset/label local audience selection. Neither is sent; the controller does not use them to suppress duplicate player sends. | **Keep harness de-duplication as a design recommendation, not official behavior.**     |
| The standard answer, Thriplash newline join, vote body, avatar body, start body, and post-game action spellings were as shown. | All are present verbatim. `PostGame_Continue` means Same Players and `PostGame_NewGame` means New Players.                                                                                  | **Confirmed.**                                                                         |
| Post-game flags use `gameFinished`.                                                                                            | The rendering branch does use `gameFinished`, although the base model oddly defaults `gameEnded` instead.                                                                                   | **Confirmed; note the model/default mismatch.**                                        |
| The main gameplay actions are answer/vote/avatar/start/post-game.                                                              | The same controller also sends start-cancel, name change, live answer, safety quip, two censor forms, episode controls, and the full `UGC` action family.                                   | **Expand the send table.**                                                             |
| A skip-tutorial action can be treated as known controller protocol.                                                            | No literal skip action or handler exists. `game.skipTutorials` is an unused default; only a data-driven action could carry a host-supplied spelling.                                        | **Mark the action name host-side/unknown.**                                            |
| Error completion can be modeled from `doneText` and answer fields.                                                             | The UI also reads generic `error`, and text filtering can reject the request through ecast error 2021. There is no dedicated duplicate-answer field in the bundle.                          | **Add the generic rejection path; do not invent a duplicate flag.**                    |
| Numeric timers may be read from controller state to derive deadlines.                                                          | No Quiplash-specific layout reads one. Only Boolean `gameIsStarting` affects the lobby.                                                                                                     | **Treat round timing as host/TV-only.**                                                |

Related corrections outside §4:

- A reload reconnect does not persist/send `device-id`; only same-page automatic
  reconnect retains it. The persisted reconnect string now has a fourth
  `branch` component.
- The active Quiplash client's first reconnect attempt is immediate, not after
  the randomized 1,000–1,499 ms delay.
- The current connect screen does not fall back from `audienceHost` to `host`.
- There is no JavaScript keepalive interval and no official production ping
  interval in these assets.
- The Quiplash bundle's object decoder constructs an entity type that supports
  `version`, but fails to pass `result.version` into it
  (`controller:20846-20865`, `controller:21171-21181`). The UI consequently
  replaces object state without version-based stale-update rejection. Advice to
  de-duplicate by entity version is sound harness design, but it is not current
  controller behavior.

## What remains host/TV-side-only

Static player assets do not reveal:

- actual round deadlines or timer extensions;
- the concrete per-session value of `maxLength`, `fieldCount`, choice keys, or
  `countGroupName`;
- whether a particular field originated in `room` or `player:{id}` after the
  merge;
- the host-supplied spelling, if any, for a skip-tutorial button;
- exact duplicate-answer wording and host validation rules;
- resolved vote totals, audience aggregation, score deltas/totals, standings,
  or winner data;
- the TV-only entity names and schemas;
- what the game host does to sockets and the room code after
  `PostGame_NewGame`.

Those require host/TV JavaScript or an authorized protocol recording. They
cannot be recovered honestly from the current player controller alone.
