---
'@nomi-ai/electron': patch
---

用量日志每 60 秒的扫描改为异步遍历并按目录 mtime 缓存列表；dsh 的 .zstd 会话在线程池里异步解压；Codex 数据库变化时只失效变动的会话缓存，不再清空全部解析结果。
