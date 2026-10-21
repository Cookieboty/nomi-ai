---
'@nomi-ai/renderer': patch
---

fix(mascot): a failed VRM load or a 3D render error no longer sticks — choosing another valid model (VRM or sprite) clears the error UI / canvas fallback and mounts the new model.
