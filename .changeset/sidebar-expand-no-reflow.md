---
'@nomi-ai/ai-chat': patch
---

fix(chat): expanding the sidebar in the "By endpoint" view no longer flickers (#57). During the expand animation the content now keeps its final width instead of re-wrapping the endpoint filter row line by line; reduced-motion users get no width animation at all.
