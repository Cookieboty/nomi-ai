---
'@nomi-ai/ai-chat': patch
---

fix(desktop-go): cancelling an MCP server connection while it is still connecting no longer leaves the connection open in the background: the handshake is cancelled too, and a client that finishes connecting after the cancel or timeout is closed instead of being left without an owner (#213).
