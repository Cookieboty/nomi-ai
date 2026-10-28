---
'@nomi-ai/host-electron': patch
---

fix(chat): stopping a reply while the "send to cloud" confirmation is still open now withdraws the confirmation and cancels that turn for good. Previously, allowing the leftover confirmation afterwards would still start the stopped request in the background (#160).
