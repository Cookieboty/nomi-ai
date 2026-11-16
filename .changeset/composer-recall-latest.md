---
'@nomi-ai/ai-chat': patch
---

fix(ui): 输入框空着按 ↑ 找回的是刚发出的那条提问，不再是更早的一条（拆分输入框时把消息读成了渲染期的快照）。 ArrowUp on an empty composer recalls the message you just sent again, not an older one (the composer split had read messages from a render-time snapshot).
