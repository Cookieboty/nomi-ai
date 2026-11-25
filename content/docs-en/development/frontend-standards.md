# Frontend Engineering Standards

These standards apply to `packages/ui`, `packages/ai-chat`, and `packages/renderer`. The goal is to let components, state, styles, and copy evolve independently while reducing regression risk across desktop windows. These rules serve as the default baseline for code review; any exception must be documented near the code and registered in the exceptions section of this file.

## Directory and Dependency Boundaries

All UI icons must use named imports from `@tabler/icons-react`, controlling size and stroke width primarily through the shared `Icon` component; namespace imports of the whole library, dynamic icon-name lookups, and runtime icon services are forbidden. Icones is only for searching and picking icons—do not import its runtime. Provider and agent product logos use shared `BrandIcon` / `EndpointIcon`, while Nomi keeps its own brand assets. From LobeHub, store only the static SVGs actually in use; update them via `scripts/icons/update-brands.mjs`, which also regenerates Dynamic Island assets, then format the generated files with Prettier.

- `packages/ui` contains only cross-window design tokens and business-agnostic components with no business state or host dependencies. Components must be exported via `packages/ui/src/index.ts`; pages must never import from internal paths inside the UI package.
- `packages/ai-chat` and `packages/renderer` organize pages by feature. A feature folder may contain `index.tsx`, local subcomponents, hooks, services, and CSS Modules; code shared across features moves up to `packages/ui` or the package's `shared` directory.
- Dependencies remain strictly unidirectional: `ui -> React/icon library`, feature packages -> `ui/types/sdk-client`, and views communicate with the Go core solely through the app contract (`services/api.ts`). The UI package must never depend on feature packages or window implementations.
- Page components handle composition and routing, presentational/feature components handle rendering and interaction, hooks handle state and side effects, services handle IPC/API adaptation, and pure logic lives in `utils`. Components must never assemble IPC channel names directly.

Top-bar panel tools reuse the original components via slots in `TitleBar/panels.tsx`, preserving panel state inside those components. Column boundaries in the desktop window use `ResizeObserver` to measure actual panel widths, while the browser preview retains the in-panel toolbar. The splash screen manages only the visual overlay and exits once the conversation index, initial messages, and first-frame layout are ready; it must never modify onboarding completion flags or conversation data.

## Files, Components, and Shared Capabilities

- Source files (`.ts`, `.tsx`, `.css`, `.json`) must not exceed 1,200 lines by default. Beyond that, split by responsibility into separate files for page composition, presentational components, state hooks, service adapters, and pure functions.
- Exceptions are permitted only for tightly coupled rendering engines, generated protocol artifacts, or external data files that cannot be safely split by responsibility; each must document its reason, owner, and future split criteria.
- Individual React components must not exceed 300 lines by default; past 200 lines, check whether a component is mixing data fetching, state machines, and layout composition.
- UI patterns that repeat twice with stable semantics should be extracted into `packages/ui`. Shared components must support keyboard navigation, focus states, disabled states, and accessible names, and be exported from `index.ts`.
- Pages must not duplicate foundational interactive structures such as `Button`, `Modal`, `FormField`, `EmptyState`, or `SectionTitle`; add explicit props or variants on shared components instead of overriding or building parallel implementations in feature layers.
- `useEffect` is restricted to subscriptions, timers, external APIs, and DOM/IPC synchronization. Derived values are computed during render; async requests must guard against cancellation or stale responses.

## Styling and Theming

- Shared components use `var(--cd-*)` tokens and the `cd-` class prefix; feature-specific styles use CSS Modules. Never scatter hardcoded colors, spacing, radii, or shadows.
- Split shared CSS by responsibility so the entry file contains only `@import` statements; base components, theme overrides, and complex controls must not be mixed in one long file.
- Interactive states must cover `hover`, `focus-visible`, `disabled`, and `reduced-motion` (where applicable). Modals must support `Esc` to close, focus restoration, and screen-reader titles.
- Menus, popovers, and drawers should not unmount immediately on close: use `usePresence(value)` from `@nomi-ai/ui` to play the exit animation first (it returns the previous value and `closing`, setting `data-closing` on the element), paired with global classes `cd-motion-pop` (menus: fade and gentle drop) or `cd-motion-slide-right` (right-side overlays: slide in from right and fade in), reversing on close; unmount immediately when reduced motion is enabled. Keep the value passed to `usePresence` referentially stable across renders (a stateful object, boolean, or string—never construct a fresh object every render).

## Accessibility and Tooltips

- Never add native `title` attributes to icon buttons, including buttons that collapse to icon-only states. Provide an explicit accessible name with `aria-label`; shared `IconButton` takes `label` and does not accept a `title` prop.
- Prefer visible copy or inline expansion for explanations; when hover explanations are needed, use `Tooltip` or `FloatingTip` from `@nomi-ai/ui` with keyboard focus and `Esc` dismissal. Keyboard shortcuts must never be conveyed solely via hover tooltips.
- Truncated text may keep a native `title` attribute to show the full string (such as filenames, paths, model IDs, or timestamps), which `installTitleTooltips()` intercepts and renders as a custom styled tooltip. The `title` prop used for visible headings in `Modal`, `SettingRow`, `EmptyState`, etc. is unaffected.
- Meaningful standalone static icons use `role="img"` + `aria-label`; decorative icons accompanied by equivalent text use `aria-hidden` to avoid duplicate announcements.

## Internationalization

- User-facing copy uses stable `project.module.message` keys via `t()` / `tr()`; logs, model prompts, protocol fields, and parsed data must be explicitly configured as exceptions in the i18n check setup.
- Dictionaries are centralized in `packages/i18n/src/locales/<language>/<project>/<module>.json` with `zh` as the baseline language. Add new copy to the matching project/module file—never create locale files inside feature packages or manually edit the generated `catalog.ts`.
- Interpolation placeholders must stay consistent between `zh` and all other languages; update all languages together when editing keys and run `pnpm check:i18n`.
- Never cache translated strings inside components. Language changes trigger re-renders via `useLocale`; dynamic strings must also go through the translation function.

## Performance and Testing

- Lazy-load panels and heavy dependencies by feature; Rive scenes, charts, and editors must stay out of the initial shared chunk.
- Lists use stable keys and virtualization or pagination; event listeners, IPC subscriptions, animation frames, and object URLs must be released in cleanup functions.
- Shared components are tested for behavior and accessibility, feature components for key state transitions, and pure functions for edge cases. Tests must never depend on real network access, system clock, or unisolated `userData`.
- Before committing, run at least `typecheck`, `lint`, and `test` for affected packages; for cross-package changes, also run root `pnpm test`, `pnpm typecheck`, and `pnpm build`.

## Review Checklist

1. Are dependency directions and shared component boundaries clean?
2. Are files and components within line-count budgets, and are any exceptions justified?
3. Is there duplicated interaction logic, duplicated styling, or an unextracted stable pattern?
4. Are loading, empty, error, disabled, keyboard, focus, and reduced-motion states complete? Are icon buttons named strictly via `aria-label` with no native `title`?
5. Is copy placed in the right locale module, with placeholders and English translations in sync?
6. Are side effects cancellable, properly cleaned up, and guarded against stale responses?
7. Have behavioral tests been added and checks passed for affected packages?

## Automated Checks and Exceptions

Run `pnpm check:frontend` to verify frontend source line-count budgets; the repo ESLint rule `nomi/no-icon-title` (under `pnpm lint`) blocks native `title` attributes on icon buttons (see "Accessibility and Tooltips"). Currently, the sole registered exception is `packages/avatar-runtime/src/layeredRig.ts`: it is a tightly coupled Canvas2D animation and rendering engine where splitting would alter rendering order; it will only be decomposed once explicit animation/rendering module boundaries are introduced. All other files exceeding 1,200 lines must be split.
