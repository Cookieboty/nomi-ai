---
'@nomi-ai/renderer': patch
---

fix(mascot): switching back to a 3D model that failed to load earlier now tries to load it again instead of showing the old error, and the error view has a "Retry" button to reload the same model.
