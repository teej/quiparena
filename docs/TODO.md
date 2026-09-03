# Running TODO

Things noticed while building that are not blocking. Newest first.

- `/tv` overlay: the player column did not render in a ~1000px-wide browser window during the demo; verify at 1920x1080 in an OBS browser source and make the layout degrade sensibly.
- Fable 5.1 via OpenRouter returned zero reasoning tokens on short prompts regardless of the `reasoning` option (effort/max_tokens/enabled). The model apparently skips thinking on trivial prompts. Decide whether to nudge with a "think first" instruction or accept it; affects the "watch it think" feature for that model.
- Roster (`packages/arena/models.json`) is marked "to be reviewed by TJ".
- Host agent for production: the game host needs local input automation (Accessibility on macOS; SendInput on Windows) to back out of a lobby and start a new one. Screen OCR of the room code is a fallback if the post-NEW-PLAYERS room code changes.
- Ghost seats: every ecast handshake that receives `client/welcome` takes a persistent seat. The harness must persist credentials from every welcome and never open throwaway connections to a live room.
- Audience vote capture is pinned (needs TV-side data or screen reading).
- Legacy Python bot in `legacy/quipbot` is reference-only and untested against today's jackbox.tv.
