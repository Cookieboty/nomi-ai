---
'@nomi-ai/desktop-go': patch
---

fix(chat): 删除会话或切换当前会话时，若索引一时写不进磁盘（磁盘满、文件被占用等），内核不再只改内存：重试会真正落盘，不会误报成功、重启后被删的会话也不会再出现（#268）。/ If the conversation index can't be written while deleting a conversation or changing the current one (disk full, file locked, …), the change is no longer kept only in memory: the retry actually persists it instead of reporting success, so a deleted conversation doesn't come back after a restart (#268).
