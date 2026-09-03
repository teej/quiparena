# QuipArena style guide

Inferred 2026-09-02 from TJ's other projects on this machine, read-only.
Most weight on the newest and most finished work: VBLANK (Aug 2026),
suicide-slimes (May 2026), vibes/vtt and vibes/uno (Jan 2026), downlink
(May 2025), titan-web / applytitan.com (2024-25), teejm.com (2024).
Each item carries a confidence note. Where projects disagree the newest
evidence wins and the disagreement is called out.

## Headline

- Small, tight, monospace-forward. Hairlines, no shadows, one accent.
- Uppercase letterspaced micro-labels are the signature move. Every era, every platform.
- One locked palette of four to six tokens, commented at the top of the file.
- Berkeley Mono when it is a brand. System stack when it is an app. Never Google Fonts.
- Copy is terse. One-word statuses. Footers are signatures, not legalese.

## Fonts

| Role | Choice | Evidence | Confidence |
|---|---|---|---|
| Labels, numbers, status, nav, buttons, prompts | **Berkeley Mono** (400/700), self-hosted `woff2`, `local()` first | `/Users/teej/Code/downlink/marketing/src/index.html` (`body { font-family: 'Berkeley Mono' }`, self-hosted `/fonts/`), `/Users/teej/Code/applytitan.com/index.html:9-14` (preloaded woff2), `/Users/teej/Code/titan-web/frontend/src/app.css` (`.button { font-family: "Berkeley Mono"; text-transform: uppercase }`), `~/Library/Fonts/BerkeleyMono-*.ttf` installed | High. Four projects over two years. |
| Body / reasoning prose | System sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto`) | `/Users/teej/Code/vibes/vtt/src/index.html` (system stack), VBLANK uses platform Roboto with no font files at all | High for apps. |
| One serif interruption for the big line | `"Times New Roman", Times, serif` | `/Users/teej/Code/downlink/marketing/src/index.html` `.tagline` is Times at 1.5rem inside an all-mono page; `/Users/teej/Code/suicide-slimes/style.css` body is `Georgia, serif`; teejm.com is browser-default serif | Medium. It is a move he makes, not a default. |
| Google Fonts | Don't | Exactly one import in the whole corpus: Space Grotesk in `/Users/teej/Code/vibes/uno/src/web/styles.css:1`. Every branded project self-hosts. | High. |

Licensing: Berkeley Mono is a paid font. The CSS declares `@font-face` with
`src: local("Berkeley Mono"), url(/fonts/BerkeleyMono-Regular.woff2)`. The
woff2 files are not committed; drop them in `apps/web/client/public/fonts/`
on deploy. Without them the site falls back to `ui-monospace, "SF Mono",
Menlo, Consolas` and still looks right.

## Palette

Dark by default in 2026. Never pure white on pure black. One accent, always
orange-red. Semantic colors desaturated.

```
--night   #0a0b0d   page            (VBLANK Night #07090B, vtt #0a0a0b, uno #0b0f13, downlink Night #080C12)
--panel   #131518   raised surface  (VBLANK Panel #171A1D @80%, vtt #18181b)
--ink     #f2eee7   text            (VBLANK Ink #F2EEE7, uno #f5e9cf, vtt #e8e8e8)
--muted   #a3a6a3   secondary       (VBLANK MutedInk #A8AAA8, vtt #a1a1aa)
--dim     #6c706e   tertiary        (vtt #71717a, teejm rgba(0,0,0,.35) rules)
--line    rgb(242 238 231 / 14%)   hairline, ink-tinted (VBLANK Hairline #7E8588 @33%, slimes rgba(53,29,26,.12))
--accent  #f24213   the one accent  (titan-web --primary #f24213, downlink #eb5531 / persimmon #FF461A, applytitan #d34021)
--ok      #a7d8b6   sage            (VBLANK Results)
--warn    #d6a19b   clay, not red   (VBLANK Failure)
```

Evidence: `/Users/teej/Code/VBLANK/app/src/main/java/com/vblank/launcher/ui/VblankApp.kt:89-93,711-714`,
`/Users/teej/Code/vibes/vtt/src/index.html`, `/Users/teej/Code/titan-web/frontend/src/app.css`
(palette pinned in a comment block at the top), `/Users/teej/Code/downlink/client/frontoffice/src/app/globals.css`.
Confidence: high on dark + off-white + orange-red accent; medium on the exact
neutrals (every project picks its own near-black).

Disagreement: vtt uses Linear indigo `#5e5ce6` because it is imitating Linear.
The three branded projects all use orange-red. Orange-red wins. It also reads
well over Quiplash's purple TV screen, which lime did not.

Per-model colors: the reducer hashes a model id to `hsl(h 62% 58%)`. The client
drops saturation and raises lightness before painting (`hsl(h 45% 70%)`) so
eight model colors sit in the same desaturated family as the rest of the page
(uno desaturates UNO's primaries: `/Users/teej/Code/vibes/uno/src/web/scenes/GameScene.ts:13-19`).
Confidence: medium.

## Type scale and density

- Body 13-14px, labels 10-11px, app headings 15-18px. `h1 { 1.1rem }` in titan-web
  (`/Users/teej/Code/titan-web/frontend/src/lib/components/headers/H1.svelte`),
  `h1 { 1.5rem; font-weight: 500 }` in vtt. Headings in apps are small. Confidence: high.
- Micro-label: uppercase, `letter-spacing: .06-.1em`, muted, mono, 10-11px.
  `/Users/teej/Code/suicide-slimes/style.css` (`11px; letter-spacing: .08em; uppercase`),
  vtt (`0.75rem uppercase .05em`), applytitan `h3.built-tagline` (Berkeley Mono uppercase
  `rgba(0,0,0,.56)`), VBLANK (`8-11.sp`, `letterSpacing 0.8-2.sp`), teejm.com section rules.
  Confidence: very high. Non-negotiable.
- Marketing and TV get airy (`3rem` h1, 52-120dp TV padding). Apps get tight
  (`td { padding: 2px 4px }` in `/Users/teej/Code/ganbaru/src/components/MoveTable.svelte`).
  QuipArena is an app that is also watched on a TV: tight inside the panes, generous between sections.
- Display moments use `font-weight: 300-500`, never 800. VBLANK display is `FontWeight.Light`;
  downlink h1 is bold but tracked `-0.05em`. Confidence: medium.
- Negative tracking on the one big line: `letter-spacing: -0.05em` (downlink), `0.01em` (applytitan h1). Medium.

## Radius, borders, depth

- Radius ladder small and stepped: `12 / 8 / 6 / 4` (vtt), `0.5rem` (titan-web), `0`
  on downlink marketing. Pills only for status chips (`999px`). Confidence: high.
- Borders: 1px (0.5px on TV) hairlines tinted with the ink color at 10-35% alpha. Never grey-on-grey. High.
- Shadows: none. VBLANK has zero in 1000+ lines; vtt has zero. Depth comes from alpha panels
  and hairlines. Focus is a 1px ring (`box-shadow: 0 0 0 1px`), not a glow. High.
- The one hard exception: downlink's CTA has an offset solid block (`top: 8px; left: 8px`,
  zero blur) that slides under on hover. A print/riso hard shadow. Use at most once. Medium.
- Asymmetric bottom border (`border-b-2`) for a letterpress button in titan-web
  (`/Users/teej/Code/titan-web/frontend/src/lib/components/ui/button/index.ts`). Low; noted.

## Motion

- `transition: 0.15s ease` is the default; `0.2s` for color and filter. vtt, downlink, applytitan. High.
- Ambient motion is slow and linear: 5.5s breath, 6s border sweep, 24s cloud phase in VBLANK
  (`VblankApp.kt:615-633`). Nothing bounces except characters. High.
- Streaming text: typewriter with a 300ms grace period so the reveal does not flicker
  (`/Users/teej/Code/vibes/crawdaddy/.../DaddyAnimationModel.swift`). Reuse the idea: the
  "streaming" indicator waits before flipping off.
- Rubric from `/Users/teej/Code/vibes/crawdaddy/docs/DELIGHT_MOMENTS_MAP.md`: intentional,
  payoff, replayable; "feel alive without stealing attention"; "no repetitive loop becomes
  obvious in under 30 seconds". Apply to the live pulse and the vote reveal.
- `prefers-reduced-motion`: he never writes it himself. Write it anyway.

## Layout

- Single column, centered. `max-width` 600 (vtt) / 800 (applytitan, teejm) / 1000 (downlink).
  The live grid is the exception and goes full-bleed because eight panes need the width.
- Grid `repeat(auto-fit, minmax())` for card sets; flex column for pages. Medium.
- Sections separated by hairline rules with an uppercase label sitting in the rule
  (`/Users/teej/Code/teejm.com/dist/index.html` `section:before/:after`). High.
- ASCII chrome as ornament: `├─ └─` tree links, `>>>>` fills, `/src/dev` headings
  (`/Users/teej/Code/downlink/marketing/src/index.html`). Use sparingly; it is a brand tell.
- Attribution as a design element: VBLANK shows photographer / license / source at all times.
  For QuipArena the equivalent is the model id and the vote provenance always being visible.

## Copy voice

From `/Users/teej/Documents/autoblog/CLAUDE.md` and the UI strings across projects:

- Short sentences. Cut every unnecessary word, then cut again. No throat-clearing.
- Status is one word, uppercase: `FOUND`, `SENT`, `RETRY`, `LOCKED`. (VBLANK, uno log labels.)
- Instructions are imperative and mechanical: `ARROWS CHOOSE  /  OK OPENS`, `Hold C to record`.
- Empty states name the absence plainly: `No priority`, `None`, `Ready`. No "oops", no apologies.
- Separator is ` / ` with spaces on both sides (VBLANK footer, downlink footer).
- Real typographic quotes and non-breaking hyphens. No exclamation points except as a joke (`Copied!`).
- Never Title Case for labels. Lowercase sentence case or all caps.
- Footers are signatures: `deus ex machina >>>>`, `made by teej`. Jokes go in source comments.
- Talk to the reader as a peer who knows what a Bradley-Terry model is. Do not explain twice.

## Do / don't

Do: hairlines, one accent, mono micro-labels, small headings, tabular density, ` / ` separators,
self-hosted fonts, tiny commented palette, fixed-height panes that never reflow while streaming.

Don't: Google Fonts, gradients as decoration (scrims only), drop shadows, glows, saturated
primaries, emoji in chrome, Title Case, rounded-everything, "dashboard" stat cards, uniform
card grids with no hierarchy, AI-generated imagery (VBLANK `docs/ambient-art.md` forbids it
outright), lore or backstory (`/Users/teej/Code/suicide-slimes/DESIGN.md:318` "Don't write lore"),
design systems before the thing is proven fun.

## Method

Applied from Anshu Chimala, "How to turn your AI into a world-class designer"
(Lenny's Newsletter, 2026-09-01). Techniques 7-8 sit behind the paywall; their
names and the task brief were enough to act on.

1. **Seed strings.** Three 40-char strings from `/dev/urandom` seeded three directions
   before any pixels: `rJuF7I5YoE4Y…` read as broadcast (repeated capitals, wide letterforms,
   a scoreboard), `OR8WASTCeiHJ…` read as editorial (`WAST`, `ceiHJ`: a masthead, numbered
   columns), `OhlPen35LGVs…` read as instrument (`Pen`, `LGV`, digit clusters: a pen plotter,
   a rack panel). The strings never appear in the UI.
2. **Ambitious prompts.** The brief for each direction was written as a scene, not a component
   list: "a sports broadcast truck at 2am", "the games page of a Sunday paper", "an eight-channel
   rack unit with the covers off". The winner took the third scene and kept the second's one
   serif line.
3. **Feedback loop.** Each direction was rendered as a throwaway skin of the real Live page
   against the synthetic game, screenshotted headless at 1920x1080, and scored by a critic
   agent that saw only the screenshots and this file, never the code. Round one picked
   "instrument" (taste 8, tells 8) with "editorial"'s serif headline grafted on; broadcast
   lost on filled pills and identical cards, editorial on italics everywhere. Round two:
   mono 28px tabular vote counts, headline on one line, no `[WAITING]`, vendor names hidden
   under 1440px, replay cards that toggle their own reasoning, underline toggle on the
   leaderboard, thicker dividers on /tv. Round three: answer line clamps at 720p, /tv text up
   two sizes, kicker removed while voting, quieter idle panes, shorter Games and Leaderboard
   copy. Two critic asks were declined: the per-pane `> prompt` line stays (each model has
   its own prompt in rounds 1-2), and the sweep bar stays on voting panes (they are streaming).
   Screenshots for every round are in the session scratchpad under `design/`.
4. **Image generation** is unavailable here. Where an image would have gone (the empty
   arena, the wordmark, the vote reveal) there is hand-drawn inline SVG or typographic
   composition instead. If a generated asset is wanted later it belongs in exactly one place:
   the empty-state block on the Live page, as a single desaturated still, credited.
5. **Video generation** is unavailable and would be wrong here anyway; the game screen next
   to the overlay is already video. The only motion is the streaming caret and a 6s linear
   sweep on the pane that is currently thinking.
6. **Cut.** Removed: the "LIVE EVAL" pill, the stat strip (four boxes saying the same thing
   as the header), the "Reasoning trace" `<details>` chrome, the per-card "Prompt" eyebrow
   (the prompt is the second line of the pane), the avatar squares, the Q monogram, the
   waiting orbit spinner, the radial background wash, the winner card on replay, and the
   arrow glyphs on list rows.
7. **AI tells removed.** Lime-on-black acid accent, `Manrope 800` display weight, glass
   panels with box-shadows, uniform 4x2 cards with identical eyebrows, emoji, "Arena standing
   by", "Rebuilding game tape…", the ellipsis-everywhere loading copy, the radial gradient
   hero wash.
8. **Copy by hand.** Every string was rewritten in the voice above. Statuses are one word.
   The leaderboard explainer says what the number is and stops. The footer is a signature.
