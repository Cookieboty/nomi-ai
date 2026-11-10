---
'@nomi-ai/desktop-go': patch
---

fix(harness): 同时开着较多编程助手标签时，消息还在写入磁盘就不会被清出内存，重新打开不会用旧记录盖掉还没落盘的内容（#323）。 / With many coding-agent tabs open, messages stay in memory until the write has landed, so reopening a tab cannot replace them with an older copy (#323).
