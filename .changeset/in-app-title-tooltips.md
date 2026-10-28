---
'@nomi-ai/ui': patch
---

feat(ui): hover tooltips everywhere (buttons, icons, truncated names — anything with a `title`) now use Nomi's own tooltip instead of the system one, in both the chat window and the Nomi window. It follows the theme, appears after a short pause (instantly when moving along a toolbar), shows for keyboard focus too, and hides on click, scroll or Esc.
