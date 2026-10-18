---
'@nomi-ai/ai-chat': patch
---

fix(chat): keep the send, microphone and headset buttons on the same row as the composer toolbar — the toolbar no longer wraps when the window is narrow or the working directory / provider / model names are long; the left-hand pickers shrink with an ellipsis and then collapse to icons (backend, working directory, model label, provider manage key) based on the toolbar width, and the plugin / provider buttons keep their size. Adds the E28 headed layout regression and a CSS-contract unit test.
