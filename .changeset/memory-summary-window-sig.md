---
'@nomi-ai/electron': patch
---

fix(memory): automatic conversation summaries keep updating once a conversation reaches the 1000-message storage limit, and are refreshed when the latest reply is regenerated or edited (same message count). Each summary now remembers a fingerprint of the messages it covered instead of relying on the message count alone.
