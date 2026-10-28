---
'@nomi-ai/ai-chat': patch
---

feat(chat): `/model` opens the same model menu as the model button above the input instead of adding a list card to the conversation; when the argument matches several models the menu opens with it in the search box, and a unique match still switches right away. Typing `/model ` now completes model names like `/agent ` does (↑↓ to choose, Tab or Enter to fill in, Esc to close), from the same list `/model` matches against.
