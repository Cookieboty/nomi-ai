---
'@nomi-ai/host-electron': patch
---

fix(cli): on Windows and other case-insensitive filesystems, the PATH scan now returns the real on-disk file name (`dsh.cmd`) instead of the upper-case PATHEXT form (`dsh.CMD`), matching what `where` reports.
