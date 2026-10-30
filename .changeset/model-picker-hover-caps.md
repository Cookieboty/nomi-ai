---
'@nomi-ai/ui': patch
---

fix(ui): the model picker no longer shows capabilities (reasoning · vision · context) next to each model, which truncated model names; they appear in a hover tooltip with the full name instead. Dropdown options and the trigger now use an in-app tooltip (new `FloatingTip`) instead of the system `title` tooltip, shown beside the menu after a short pause on mouse hover or arrow-key navigation. `SelectOption` gains a hover-only `hint`.
