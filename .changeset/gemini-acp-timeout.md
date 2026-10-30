---
'@nomi-ai/host-electron': patch
---

fix(gemini): ACP requests now time out instead of hanging forever. Handshake requests give up after 2 minutes; a turn is cancelled (`session/cancel`, process recycled) after 5 minutes without any output, never while waiting for a permission answer. The error is translated.
