---
'@nomi-ai/electron': patch
---

fix(git): discarding a whole new (untracked) folder in the Changes panel now works and can be undone. Folders are classified by the files inside them instead of being treated as tracked files, and a folder with both tracked changes and new files has both discarded (#153).
