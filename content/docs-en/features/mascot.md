# Desktop Character: Nomi

![Nomi](../screenshots/mascot.webp)

Nomi lives in a small transparent always-on-top window where only the character itself is clickable; clicks on the rest of the window pass straight through to windows underneath.

## What She Does

- **Expressions and actions**: Expressions such as happy, annoyed, sad, and relaxed change with chat and task status; she blinks, breathes, follows the cursor with her eyes, and lip-syncs while speaking. She has 43 named actions (see "Actions" below): giving a thumbs-up when a task finishes, apologizing when it fails, resting her chin while thinking, typing while tools run, and looking around, humming, or yawning when idle. The AI can also call tools to trigger gestures and expressions.
- **Interactions**: Hovering, petting her head, single-clicking, and double-clicking each trigger distinct responses (expression + action + line), and double-clicking opens the chat window. Drag to reposition; with "Gravity & landing" enabled, releasing drops her onto the taskbar or Dock with a bounce. Near the right edge of the screen, the toolbar and bubble flip to her left; near the left edge, they flip to her right.
- **Speech bubble**: The first sentence or two of an AI reply appear beside her, with "Read full" on long replies to open the chat window. Can be turned off in interaction settings.
- **Drop a file on her**: Dropping a file onto Nomi summarizes its contents (one sentence in the bubble, full summary written to the chat window).

## Actions

Nomi has **43 named actions** (`packages/avatar-runtime/src/rig/actions.ts`), with common ones also accessible from the tray's character actions menu. AI tools `avatar_gesture` / `avatar_emotion` and in-app alerts only send **semantic names** (gestures `thumbsUp`, `shakeHead`, emotion `happy`, activity `thinking`, etc.; see the vocabulary in [Character Pack Contract](../character-pack/CONTRACT.md#mappingjson)), which the character pack's `mapping.json` (official pack `characters/nomi/mapping.json`) maps to the actions below. Gestures and emotions without mappings in a character pack are ignored.

| Action | Name | Category | Duration | Priority | Trigger scenario | In-app auto trigger |
| --- | --- | --- | --- | --- | --- | --- |
| `wave` | Wave | Greet | 2.3s | 1 | Greeting / good morning / first open / user says "hello" | Startup / greeting; text contains "hello / bye"; click hand |
| `hello` | Greet | Greet | 1.9s | 1 | Light greeting on first appearance (nod + small wave) | First UI appearance (startup greeting) |
| `nod` | Nod | Agree | 1.2s | 1 | Answering "OK / got it", confirmation | Reply contains "OK / sure"; click head; head pat |
| `shake_head` | Shake head | Agree | 1.4s | 1 | Refusal, "no / not available" | Click skirt (annoyed); negative or sad sentiment in reply |
| `bow` | Bow | Greet | 2.0s | 1 | Polite thanks / farewell / apology | Reply contains "thank you / sorry" |
| `salute` | Salute | Greet | 1.9s | 1 | Order received / "Copy that!" | — |
| `think` | Chin-rest thinking | Think | 3.4s (hold) | 1 | AI thinking / long wait | AI thinking / waiting on model (held until reply finishes) |
| `explain` | Explain | Think | 2.6s | 1 | Long answer / explaining steps (index finger raised) | Reply exceeds 280 characters |
| `eureka` | Eureka | Think | 2.2s | 1 | Found an idea / solved the problem | — |
| `puzzled` | Puzzled head tilt | Think | 2.4s | 1 | Unclear / needs clarification | — |
| `look_around` | Look around | Idle | 3.0s | 0 | Random idle / waiting for user (hand shielding brow) | Random idle |
| `look_lr` | Look left and right | Idle | 2.6s | 0 | Random idle | Random idle |
| `peek` | Peek | Emotion | 2.6s | 0 | Random idle (shyly peeking at user) | Random idle |
| `heart` | Heart gesture | Emotion | 2.6s | 1 | Expressing fondness / praised / head pat | — |
| `blow_kiss` | Blow a kiss | Emotion | 2.4s | 1 | Farewell / thanks | — |
| `shy` | Shy | Emotion | 2.8s | 1 | Praised / petted too long | — |
| `cover_face` | Cover face | Emotion | 2.6s | 1 | Embarrassed / awkward after a mistake | — |
| `sorry` | Apologise | Emotion | 2.8s | 3 | Task failed / error (hands clasped in front, slight bow) | Task / endpoint failed (synced with Dynamic Island) |
| `surprise` | Surprised | React | 1.8s | 2 | File dropped / sudden event | File dropped; click face / body; landing |
| `sigh` | Sigh | Emotion | 3.0s | 1 | Repeated failure / bored | — |
| `pray` | Prayer hands | Emotion | 2.8s | 1 | Gratitude / favor / plea | — |
| `smug` | Smug | Emotion | 2.4s | 1 | Solved a hard problem / succeeded on first try | — |
| `aggrieved` | Aggrieved | Emotion | 3.0s | 1 | Criticized / repeated failure | — |
| `tears` | Tears | Emotion | 3.0s | 1 | Touched / very sad | — |
| `angry` | Annoyed (mild) | Emotion | 2.2s | 1 | Interrupted / consecutive failures | — |
| `cold_sweat` | Cold sweat | Emotion | 2.4s | 1 | Nervous / awkward / timeout | — |
| `daze` | Daze | Idle | 3.4s | 0 | Random idle | Random idle |
| `cheer` | Cheer (fist pump) | Celebrate | 2.2s | 1 | Encouraging user / starting a new task | Enthusiastic happy reply; "great / congrats" |
| `thumbs_up` | Thumbs up | Celebrate | 2.2s | 3 | Task complete / well done | Task / endpoint complete (synced with Dynamic Island) |
| `peace` | Peace sign | Celebrate | 2.2s | 1 | Photo / selfie / happy | — |
| `ok_hand` | OK gesture | Celebrate | 2.2s | 1 | Confirm / no problem / OK | — |
| `celebrate` | Celebrate (hands up) | Celebrate | 2.6s | 3 | All tasks complete / milestone | All tasks complete |
| `clap` | Clap | Celebrate | 2.4s | 1 | Praise / user reached a goal | Happy reply; double-click |
| `hop` | Happy bounce | Celebrate | 1.6s | 1 | Clicked / happy | Click |
| `wink` | Wink | Emotion | 1.6s | 1 | Playful / easter egg | — |
| `tongue` | Stick out tongue | Emotion | 1.8s | 1 | Playful / after a minor slip | — |
| `cute` | Act cute | Emotion | 2.4s | 1 | Head pat / playful request | — |
| `work` | Typing at work | Work | 2.4s (hold) | 1 | Tool running / writing code | Tool running (held) |
| `yawn` | Yawn | Rest | 3.0s | 0 | Nighttime / prolonged idle | Nighttime / prolonged idle |
| `stretch` | Stretch | Rest | 3.2s | 0 | Prolonged idle / break reminder | Prolonged idle |
| `goodnight` | Good night | Rest | 3.4s (hold) | 1 | Late night / long inactivity / saying good night | Late-night idle (held) |
| `listen` | Listen | Think | 2.6s (hold) | 1 | User typing / voice input | — |
| `peek_note` | Humming | Idle | 3.0s | 0 | Random idle / playing music | Random idle |
| Priority: 0 idle · 1 normal · 2 interactive reaction (click / file drop) · 3 task event (complete / failed). Higher priority replaces the playing action; lower priority is dropped by default. Held actions (Chin-rest thinking, Typing at work, Listen, Good night) hold their end pose until the reply finishes, a higher-priority action replaces them, or the max hold duration expires. |

### Trigger Rules

- **Task events**: Turn finished → Thumbs up; all finished → Celebrate (hands up); failed → Apologise.
- **Chat**: Waiting on model → Chin-rest thinking; tool running → Typing at work; reply over 280 characters → Explain; keywords like "hello / thanks / congrats" in replies → Wave / Bow / Cheer (fist pump).
- **Interactions**: Click, double-click, head pat, and file drop each trigger their corresponding action.
- **Idle**: After 18 seconds of quiet, occasionally performs a random idle action (Look around / Look left and right / Peek / Daze / Humming); after 1.5 minutes idle, may Yawn; after 2.5 minutes idle, may Stretch; between 23:00 and 06:00, biases toward Yawn / Good night. Never triggers while speaking, thinking, or playing another action, and is completely disabled when the system "Reduce motion" setting is on.

## Display Mode

Shows a static illustration by default. Turning on "Nomi animation (Rive)" under "Settings → General → Startup & Window" switches to the Rive animation (uses slightly more RAM and GPU). Animation assets download on first enable; the static illustration remains visible until the download finishes or if it fails.

Nomi is the only built-in character; character switching and custom model imports are not supported. "More → Credits" on the toolbar lists the authors and licenses of the character and icons. See [Brand Guidelines](../BRAND.md#9-brand-lock) for brand rules.

## Toolbar

Vertical toolbar beside the character: AI Chat, Voice (click to mute, right-click for voice preferences), and other frequent controls; the rest live under "More" (size, close Nomi, quit app, etc.). Fades out when idle, appears when the cursor approaches, and flips automatically to the opposite side near screen edges.

Closing Nomi hides her from the desktop and stops voice playback and wake-word listening; alerts are routed through the [Dynamic Island](dynamic-island.md) or system notifications instead. You can reopen her under "Settings → General → Startup & Window".

## Size

Defaults to 50%, adjustable from 30% to 150% (based on a 420×450 character box at 100%); on smaller screens, the upper bound scales down automatically to fit the work area.

| Entry point           | Usage                                                       |
| --------------------- | ----------------------------------------------------------- |
| Ctrl / ⌘ + Scroll     | Hold `Ctrl` (`⌘` on macOS) and scroll over the character    |
| Context menu          | Right-click the character → Zoom in / Zoom out              |
| Settings → General    | "Nomi size" slider and reset under "Startup & Window"       |

The bottom-center anchor under her feet stays pinned on screen while resizing; the size value is saved locally and persists across launches.

## Interaction Settings

Tray → "Interaction settings (click-through / gravity / stroll)…":

| Option                         | Default | Description                                                      |
| ------------------------------ | ------- | ---------------------------------------------------------------- |
| Click through transparent areas | On     | Passes clicks on transparent pixels to windows underneath        |
| Gravity & landing              | Off     | Falls onto the taskbar / Dock on release and bounces off edges   |
| Stroll occasionally            | Off     | Walks short distances along the bottom of the screen now and then |
| Touch reactions                | On      | Responses to hovering, head pats, and clicks                     |
| Eyes follow the global cursor  | On      | Tracks the pointer even when outside the character window        |
| Show AI replies in bubble      | On      | Displays replies in the speech bubble beside her                 |

## Adding a New Action

1. Add an entry to `ACTIONS` in `actions.ts`: `id` (lowercase snake_case), `label` (UI locale key), `category`, `dur`, `trigger`, and tracks; add the Chinese label under `packages/i18n/src/locales/zh/ui/` and the matching English label under `en`.
2. Modify only action and pose parameters—never alter layers, anchor points, or layout (brand lock).
3. Add a row to the table on this page and update the action count above: `packages/renderer/tests/mascot/motionDocs.test.ts` checks that every action's `id` and Chinese name are listed on this page.
4. To wire up automatic triggers, update `packages/avatar-runtime/src/expressionDirector.ts` (events → actions) or `src/rig/idleBehavior.ts` (idle pool).

## Implementation

- Avatar engine: `packages/avatar-runtime` (actions in `src/rig/actions.ts`, layered rig in `src/layeredRig.ts` for `sprite`-mode character packs); Nomi window: `packages/renderer`.
- Window, drag physics, and sizing: `apps/desktop-go/internal/core/mascot` (`controller.go`, `physics.go`, `mascot_size.go`).
- Click-through on Linux uses window shape masks; Wayland does not expose global cursor coordinates.
