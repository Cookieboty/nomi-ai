---
'@nomi-ai/host-electron': patch
---

fix(usage): refreshing quota right after "Clear usage data" now fetches fresh values instead of returning nothing for up to a minute: clearing resets the refresh throttle and no longer lets a new refresh reuse one that was started before the clear.
