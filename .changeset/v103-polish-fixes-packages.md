---
'@nomi-ai/ui': patch
'@nomi-ai/voice': patch
---

fix: pre-release polish. "Fork as new chat" now shows the copy in the sidebar right away (the list used to refresh only when the message count changed); the mascot speech bubble renders Markdown replies as plain text instead of showing raw `**` / backticks / `#`; the voice error pill ("No microphone found") dismisses itself after a few seconds; the chat hands-free tooltip is no longer clipped at the window's right edge and long mascot toolbar tooltips wrap inside the window (they still open to the left of the bar); the largest mascot size keeps a few pixels of slack to the display work area so it cannot end up 1px taller than the screen after DPI rounding on Windows.
