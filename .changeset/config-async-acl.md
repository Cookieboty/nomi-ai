---
'@nomi-ai/electron': patch
---

Windows：config.json 日常保存改为异步原子写（异步 icacls，连续保存合并、最新内容最后落盘），退出时仍同步写入最新配置；用量账本压缩不再同步调用 icacls。原子写的逐文件兜底改为在 rename 前收紧临时文件，目标文件出现时即私有。
