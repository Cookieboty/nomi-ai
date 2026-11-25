# Personalization

Theme and app icon settings live under **Settings → General → General → Appearance**.

## Themes

Options: **Light** (default for new users), **Dark**, **Sunset**, **Warm ink**, **Graphite**, **Cream**, **Cool mist**, **Follow system** (dark when the OS is dark, light when light), and **Image theme**. The chat window, settings, onboarding, and title bar switch together; users who already picked a theme keep their existing choice.

### Image Theme

After selecting **Image theme**, the image picker, **Frosted glass**, and **Mask opacity** appear beneath the theme cards:

- A crisp background image fills the window across chat, sidebar, right panel, settings, and dialogs. **Frosted glass** adjusts the background-sampling blur of the global overlay mask without scaling or blurring the underlying image itself, keeping text and controls sharp.
- **Mask opacity** adjusts only the overlay mask, not the image: higher values make the mask more opaque and the image subtler. Setting **Frosted glass** to `0px` disables blur. The theme card previews the mask effect in real time.
- Uses the built-in preset image (`apps/desktop-go/assets/backgrounds/nomi-preset.jpg`) by default, and can be replaced with your own image. Chosen images are cached so they still load after restart even if the original file is moved or deleted; changing the image preserves your blur and opacity settings.
- Defaults to `0px` frosted glass and `50%` mask opacity; **Reset to default** restores the preset image and these defaults without leaving Image theme.
- Image theme uses the Graphite palette; delegation cards, tasks, and library panels also use transparent surfaces.

### My Themes (Custom Themes and Theme Packs)

Create your own palette or import theme packs shared by others. To the right of the **Themes** heading are the **Follow system** toggle, **New theme**, and **Import theme pack**; custom themes appear in the same card grid as built-in themes, sorted first (with a palette icon before the name).

- When **Follow system** is on, Nomi switches between Light and Dark with the OS; clicking any theme card or turning the toggle off locks in a fixed theme (stopping on whichever version is currently active).
- **Import theme pack** opens a modal: drag a theme pack in, or click to select a file via the system picker (canceling does nothing). Drag-and-drop supports files up to 12 MB; use the picker for larger files. **Download template** in the modal saves a dual light/dark template (`nomi-theme-template.nomitheme.json`) ready to edit and re-import.
- **New theme** opens a right-side drawer seeded with the current theme's colors and four base inputs: **Accent**, **Background**, **Surface** (cards and panels), and **Text**. You can also paste multiple `#rrggbb` values into **Paste a palette** to fill them in that order.
- Remaining colors (hover, active, borders, muted text, pressed buttons, etc.) are derived automatically. For single-variant themes, a dark background treats the theme as dark mode so window chrome and status colors (success, warning, error) follow dark conventions; a light background follows light mode.
- Enabling **Separate light and dark versions** lets you configure light and dark palettes independently so the theme switches with the OS appearance; the counterpart starts from the default Light or Dark theme using your accent color.
- **Advanced: adjust individual colors** lists overridable tokens by group—leave a field blank to keep the derived value. Supports `#rrggbb`, `rgb()`, `hsl()`, and `oklch()`.
- **Background image** adds an image to the theme (PNG, JPEG, or WebP, up to 15 MB; PNG/JPEG images exceeding 2560px on the long edge are downscaled), with **Frosted glass** and **Mask opacity** controls that make UI panels translucent, just like Image theme.
- While editing, the entire window live-previews the version you are editing (including its background image), reverting if you cancel; saving switches to the theme and syncs all windows (including desktop character speech bubbles).
- Contrast checks list contrast ratios for body text, muted text, button text, and links, flagging any pair below `4.5:1`. Accent colors are nudged automatically if button text or links lack contrast; if the accent itself falls below `3:1` against the background, it is adjusted just enough to pass for non-text elements like switches and accent lines. Body text color is never altered automatically.
- Selecting a custom theme reveals **Edit** (in the same drawer), **Export theme pack**, and **Delete** beneath the cards. Deleting the active theme reverts to the default theme. Up to 100 custom themes can be saved.

A theme pack without a background image is a single JSON file (`.nomitheme.json`); with a background image, it is a zip archive (`.nomitheme`) containing `theme.json` and `background.png` / `.jpg` / `.webp`. `theme.json`:

```json
{
  "format": 2,
  "name": { "en": "Deep Sea" },
  "author": "someone",
  "base": "dark",
  "seeds": { "accent": "#4fa3d9", "background": "#0f1a22", "surface": "#172632", "text": "#e6f0f5" },
  "tokens": { "--cd-color-success": "#3fb47a" },
  "variants": {
    "light": { "seeds": { "accent": "#2f7fb8", "background": "#f4f7f9" } }
  },
  "background": { "image": "background.jpg", "blur": 0, "opacity": 0.5 }
}
```

- `name` can be a plain string or an object keyed by language (`zh` / `en`); `base` is `light` or `dark`.
- `seeds` can omit any subset of keys to inherit them from the base theme; values must be `#rgb` or `#rrggbb`.
- `tokens` is optional and directly overrides derived values, accepting only color tokens listed in `packages/ui/src/themeTokens.ts`; values may only use hex, `rgb()`, `rgba()`, `hsl()`, `hsla()`, or `oklch()`.
- `variants` is optional and holds only the counterpart opposite to `base` (`seeds` / `tokens` as above); when present, the theme follows the OS appearance.
- `background` applies only inside a `.nomitheme` zip; `image` is the filename inside the archive, `blur` ranges from `0` to `40`, and `opacity` ranges from `0.05` to `1`.
- `format`: exports as `1` when using only `name` / `base` / `seeds` / `tokens`, or `2` when using `variants` or `background`. Older app versions do not recognize format `2` and reject importing it.
- `theme.json` is capped at 64 KB and the image at 15 MB. Invalid syntax, unlisted tokens, disallowed CSS functions (such as `url(...)` or `var(...)`), or extra files in the zip cause the entire pack to be rejected.

## App Icon

**App icon** under **Appearance**: **Sunset** (default), **Cream**, **Ink**. The window, taskbar / Dock, and tray icons update immediately; static icons in installers, executables, and Finder / Start Menu keep the default Ink icon. The macOS menu bar tray icon always uses a monochrome template icon. Icon assets are documented in [Brand Guidelines](../BRAND.md).

## Sidebar

- On the left of the sidebar is a fixed navigation rail: **Chats**, **Tasks**, and **Library** sit at the top (the first icon aligns with the top row of the session panel; toggle the session panel with the button on the left of the title bar). When agents are installed, all endpoints (**All**, Nomi, and each agent) appear vertically below a divider so one click filters sessions by endpoint. Only **Settings** sits at the bottom (Knowledge / Memory / Schedule and Extensions / MCP open from the input bar menu or shortcuts). Endpoints default to **Auto**: shown when installed locally or when sessions exist (appearing as soon as you return to the window after installing in Nomi or a terminal); **Sidebar endpoints** lets you set each endpoint to always show or hide, or drag to reorder.
- The UI has one unified layout: when any built-in CLI agent is installed locally, agent-related controls (CLI tabs, endpoints, dispatching agents) stay visible; otherwise they stay hidden, and appear automatically once an agent is installed in Nomi or from a terminal. At the top of the session panel, a full-width **New chat** button sits next to a search icon (or `Ctrl/⌘+Shift+F`) that opens the search dialog—showing **New chat** and recent chats when empty, and searching both chats and local history as you type. Bottom tabs switch between **Chats**, **Tasks**, and **Library**, opening the corresponding page directly when clicking a task or asset.
- To the right of the **Projects** heading are `…` (organize sidebar: group by project / single list) and `+` (new project: opens **Create project** and immediately starts a session inside it), revealed on hover. The top **New chat** button creates unattached sessions under **Other chats**; to start a session inside a project, use **New** on that project row. **Other chats** appears only when sessions exist outside any project and has no New button in its header. When ungrouped, **Chats** shows `…` and **New chat** on the right; **Local history** shows a refresh button.
- The window uses a Codex-style three-layer layout: the navigation rail and title bar sit on the window background, while the session panel (light gray) and chat area (white, including the center column, right column, tasks, and library) form a rounded card separated by a hairline. Collapsing the session panel turns the chat area into a standalone rounded card. The sidebar button icon in the title bar updates with the collapsed/expanded state. Above the card sits the current session name and project (hover to inspect all folders in the project; hidden on new sessions), with the session menu `…` (rename, fork, archive, close tab, delete permanently) and the changes / files panel toggle on the right.
- Sessions switch only from the sidebar, with the active session highlighted in a rounded pill. Endpoint icons are omitted at the start of rows so titles align cleanly; when agents are installed and viewing **All**, agent sessions display a small gray endpoint icon at the end of the row (Nomi is default and omits the icon), and filtering to a specific endpoint omits it as well. Hovering shows the full endpoint name in a popover card, and Nomi-delegated sessions note `Delegated by Nomi to <X>`. Agent session titles use the user's first prompt (sandbox instructions prepended by Nomi are never used as titles, and previously mis-titled sessions are corrected on startup). Rows omit timestamps; running or queued sessions show a status dot at the start of the row (announced to screen readers as running / queued) instead of repeating text at the end. Hovering or focusing a row opens a popover card showing title, endpoint, relative time, status, and project; clicking the title inside the card renames it inline (`Enter` to save, `Esc` to cancel). Row trailing actions are **Pin**, **Archive**, and **More**; pinned sessions sit in the top **Pinned** section. Projects and **Other chats** show 5 / 20 items by default with a **Show N more** control adding 5 per click, turning into **Collapse** once all are shown. Section headers use small gray text, project names sit one weight heavier than session titles, and the active session uses a tinted rounded background with slightly bolder text.
- Press `Ctrl/⌘+B` or the title bar button to collapse or expand the session panel. When collapsed, only the navigation rail remains; hovering over **Chats** or an endpoint icon pops out the session panel as an overlay so you can pick a session, closing when you move away or press `Esc`.
- The trailing **Archive** button hides a Nomi chat from the sidebar; you can unarchive or permanently delete it under **Settings → Nomi → Archived chats**. **Delete permanently** in the **More** menu asks for confirmation and cannot be undone. Agent tabs show **Close tab** as their inline action.
- Sessions are grouped by project. A project is a named set of folders (for cross-stack work, frontend, backend, and docs directories can belong to the same project), one of which is the primary folder: the session working directory, git and branches, and `AGENTS.md` resolve from it, while Nomi and agents can read and write across the remaining folders too. In **Create project**, enter a name (defaults to the primary folder's directory name) and add folders (**Add folder on this computer ⌄** lists recent directories or opens the folder picker); the first folder added becomes primary, and clicking the star on another folder promotes it to primary. Hovering a project reveals `…` (edit project: rename, add/remove folders, change primary folder, remove project) and **New** (start a new session in that project: in the **All** view it inherits the endpoint of the project's most recent session; when filtered by endpoint it follows that filter). Updating a project's folders takes effect on the next turn of existing sessions (idle agent sessions restart resuming the original session; if a session's working directory is no longer in the project, it switches to the new primary folder in a new session carrying context forward). Agent sessions whose working directory falls inside an existing project (choosing the most specific match if nested) are assigned to that project automatically—covering new sessions, sessions opened from local history, and worktree tabs delegated by Nomi, as well as backfilling earlier sessions at startup or when projects are created/edited. Sessions where **No project** was explicitly chosen above the input bar are not reassigned automatically. Removing a project only hides it without touching files on disk, moving its chats to **Other chats**.
- Projects are ordered by recent activity; projects with zero sessions are also shown (when filtering the sidebar by an endpoint, only projects with sessions for that endpoint are listed; collapsed projects display the count of currently shown sessions, hiding `0`). Each project shows its 5 most recent sessions by default, with **Show N more** for the rest; clicking a project name remembers its collapsed/expanded state. Unassigned sessions appear under **Other chats**. Section headers (**Projects**, **Other chats**, **Local history**, shown in small gray text with `>`) collapse their entire section on click (**Projects** and **Other chats** remember their state). Choosing **Single list** under `…` disables project grouping and returns to a flat list.
- Starting in `2.3.8`, sessions are organized by project: on first launch, each previously used working directory (Nomi chat workspaces and agent tab directories) becomes a single-folder project containing its existing sessions.

## Shortcuts

**Settings → General → Shortcuts** lists every customizable shortcut: click **Change** and press a new key combination (must include `Ctrl/⌘` or `Alt`, or use `F1`–`F12`). Conflicts are flagged immediately; press `Esc` to cancel.

| Default          | Action                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Ctrl/⌘+K`       | Command palette                                                                                                                      |
| `Ctrl/⌘+N`       | New chat                                                                                                                             |
| `Ctrl/⌘+Shift+F` | Search chats                                                                                                                         |
| `Ctrl/⌘+L`       | Focus input box                                                                                                                      |
| `Ctrl/⌘+,`       | Open settings                                                                                                                        |
| `Ctrl/⌘+B`       | Collapse / expand sidebar                                                                                                            |
| `Ctrl/⌘+Shift+K` | Toggle knowledge base Q&A                                                                                                            |
| `Ctrl/⌘+Shift+H` | Toggle hands-free chat                                                                                                               |
| `Ctrl/⌘+Shift+M` | Knowledge · Memory · Schedule drawer                                                                                                 |
| `Ctrl/⌘+Shift+E` | Extensions / MCP                                                                                                                     |
| `Ctrl/⌘+Shift+J` | Local models (Settings → Models & Agents → Local Models)                                                                             |
| `Ctrl/⌘+T`       | New agent tab                                                                                                                        |
| `Ctrl/⌘+Shift+W` | Close tab                                                                                                                            |
| `Ctrl+Tab`       | Next tab                                                                                                                             |
| `Ctrl+Shift+Tab` | Previous tab                                                                                                                         |
| `Ctrl/⌘+Shift+R` | Rename tab                                                                                                                           |
| `Ctrl/⌘+Shift+C` | Open the current session's working directory in a terminal (agent tab directory or Nomi project primary folder; re-validated by core) |

Fixed shortcuts (not customizable): `/` in the input box opens slash commands; `Enter` sends and `Shift+Enter` inserts a newline; `↑` in an empty input recalls your previous prompt; hold `F2` to talk; `Ctrl/⌘+Shift+F` forks the current chat into a new chat; `Ctrl/⌘+1…9` switches to the nth tab (`9` = last tab); `Esc` closes the topmost dialog or menu.

## Language

Language under **Settings → General → General → Startup & window**: Chinese, English, or Follow system.

![English UI](../screenshots/settings-en.png)

## Accessibility

- Every feature is keyboard-accessible, and all icon buttons expose readable labels.
- Dialogs trap focus; `Esc` closes only the topmost layer and restores focus to the trigger element.
- Enabling your OS's **Reduce motion** setting tones down Nomi's character animations, the Dynamic Island, and UI transitions.

## Implementation

- Themes: `packages/ui/src/theme.ts`, custom theme derivation in `packages/ui/src/customTheme.ts`, storage and theme-pack validation in `apps/desktop-go/internal/core/theme`; shortcuts: `packages/ai-chat/src/services/shortcuts.ts`; settings UI: `packages/ai-chat/src/components/SettingsView`.
- App icon switching: `apps/desktop-go/internal/core/appicon`.
