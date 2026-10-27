---
'@nomi-ai/i18n': patch
---

fix(i18n): renaming a conversation to `__proto__` (or `constructor`, `toString`…) no longer crashes the chat window. Translation only uses the dictionary's own string entries and returns unknown text unchanged (#142).
