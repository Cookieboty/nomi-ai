---
'@nomi-ai/renderer': patch
---

fix(tts): the TTS settings page logic moved from an inline `<script>` (blocked by the production CSP, so the form never loaded in installed builds) into a module loaded by `main.ts`; the strict CSP is unchanged.
