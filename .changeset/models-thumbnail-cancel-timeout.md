---
'@nomi-ai/ai-chat': patch
---

fix(models): the optional model-store thumbnail can no longer stall a model install or the store list. Thumbnail downloads now have idle and total time limits and honor cancel; cancelling during the thumbnail step stops the install and leaves the previously installed version intact; the store list returns after a short budget and fills thumbnails in from cache later. Model downloads also abort when a connection sends no data for a minute.
