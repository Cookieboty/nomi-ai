---
'@nomi-ai/host-electron': patch
---

fix(desktop-go): closing or recreating a window while its connection drops no longer risks crashing the app on a concurrent map access (#208).
